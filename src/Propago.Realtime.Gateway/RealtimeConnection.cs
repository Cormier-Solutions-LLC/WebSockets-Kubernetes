using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Propago.Realtime.Contracts;

namespace Propago.Realtime.Gateway;

public static class RealtimeCloseStatus
{
    public const WebSocketCloseStatus ServiceRestart = (WebSocketCloseStatus)1012;
    public const WebSocketCloseStatus AuthenticationExpired = (WebSocketCloseStatus)4003;
    public const WebSocketCloseStatus SlowConsumer = (WebSocketCloseStatus)4008;
    public const WebSocketCloseStatus HeartbeatTimeout = (WebSocketCloseStatus)4009;
}

public sealed class RealtimeConnection : IAsyncDisposable
{
    private readonly WebSocket _socket;
    private readonly RealtimeOptions _options;
    private readonly GatewayMetrics _metrics;
    private readonly Channel<ServerMessageEnvelope> _outbound;
    private readonly ConcurrentDictionary<string, byte> _subscriptions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _correlations = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _correlationOrder = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private RealtimeIdentity _identity;
    private long _lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;
    private int _slowConsumerStrikes;
    private int _closeRequested;

    public RealtimeConnection(
        WebSocket socket,
        RealtimeIdentity identity,
        RealtimeOptions options,
        GatewayMetrics metrics,
        string? sessionId = null)
    {
        _socket = socket;
        _identity = identity;
        SessionId = sessionId;
        _options = options;
        _metrics = metrics;
        Id = Guid.NewGuid().ToString("N");
        _outbound = Channel.CreateBounded<ServerMessageEnvelope>(new BoundedChannelOptions(options.OutboundQueueCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });
    }

    public string Id { get; }

    public RealtimeIdentity Identity => Volatile.Read(ref _identity);

    public string? SessionId { get; }

    public WebSocket Socket => _socket;

    public DateTimeOffset LastActivity => new(Interlocked.Read(ref _lastActivityTicks), TimeSpan.Zero);

    public bool IsOpen => _socket.State == WebSocketState.Open && Volatile.Read(ref _closeRequested) == 0;

    public void RecordActivity() => Interlocked.Exchange(ref _lastActivityTicks, DateTimeOffset.UtcNow.UtcTicks);

    public void UpdateIdentity(RealtimeIdentity identity) => Volatile.Write(ref _identity, identity);

    public bool TryTrackCorrelation(string correlationId)
    {
        if (!_correlations.TryAdd(correlationId, 0))
        {
            return false;
        }

        _correlationOrder.Enqueue(correlationId);
        while (_correlations.Count > _options.MaximumTrackedCorrelations &&
            _correlationOrder.TryDequeue(out var oldest))
        {
            _correlations.TryRemove(oldest, out _);
        }

        return true;
    }

    public bool TrySubscribe(AuthorizedRoute route) =>
        _subscriptions.Count < _options.MaximumSubscriptions &&
        _subscriptions.TryAdd(route.SubscriptionKey, 0);

    public bool Unsubscribe(AuthorizedRoute route) =>
        _subscriptions.TryRemove(route.SubscriptionKey, out _);

    public bool IsSubscribed(string topic, string? userId)
    {
        var key = userId is null ? $"topics/{topic}" : $"users/{userId}/topics/{topic}";
        return _subscriptions.ContainsKey(key);
    }

    public bool TryEnqueue(ServerMessageEnvelope message)
    {
        if (!IsOpen || !_outbound.Writer.TryWrite(message))
        {
            _metrics.RecordQueueDrop();
            Interlocked.Increment(ref _slowConsumerStrikes);
            return false;
        }

        Interlocked.Exchange(ref _slowConsumerStrikes, 0);
        return true;
    }

    public bool HasExceededSlowConsumerLimit =>
        Volatile.Read(ref _slowConsumerStrikes) >= _options.SlowConsumerStrikeLimit;

    public async Task RunSenderAsync(CancellationToken cancellationToken)
    {
        await foreach (var message in _outbound.Reader.ReadAllAsync(cancellationToken))
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(
                message,
                RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);
            await _sendLock.WaitAsync(cancellationToken);
            try
            {
                if (_socket.State != WebSocketState.Open)
                {
                    return;
                }

                await _socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken);
                _metrics.RecordMessage("outbound", "sent");
            }
            finally
            {
                _sendLock.Release();
            }
        }
    }

    public async ValueTask RequestCloseAsync(
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken)
    {
        if (Interlocked.CompareExchange(ref _closeRequested, 1, 0) != 0)
        {
            return;
        }

        var lockTaken = false;
        try
        {
            _outbound.Writer.TryComplete();
            await _sendLock.WaitAsync(cancellationToken);
            lockTaken = true;
            _metrics.RecordCloseCode((int)status);
            if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await _socket.CloseOutputAsync(status, description, cancellationToken);
            }
        }
        catch (WebSocketException)
        {
            _metrics.RecordCloseCode((int)WebSocketCloseStatus.InternalServerError);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Interlocked.CompareExchange(ref _closeRequested, 0, 1);
            throw;
        }
        finally
        {
            if (lockTaken)
            {
                _sendLock.Release();
            }
        }
    }

    public void Abort(WebSocketCloseStatus status)
    {
        if (Interlocked.CompareExchange(ref _closeRequested, 1, 0) != 0)
        {
            return;
        }

        _metrics.RecordCloseCode((int)status);
        _outbound.Writer.TryComplete();
        _socket.Abort();
    }

    public async ValueTask DisposeAsync()
    {
        _outbound.Writer.TryComplete();
        if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await RequestCloseAsync(WebSocketCloseStatus.NormalClosure, "connection_complete", CancellationToken.None);
        }

        _socket.Dispose();
        _sendLock.Dispose();
    }
}
