using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Cormier.Realtime.Contracts;

namespace Cormier.Realtime.Gateway;

public static class RealtimeCloseStatus
{
    public const WebSocketCloseStatus ServiceRestart = (WebSocketCloseStatus)1012;
    public const WebSocketCloseStatus AuthenticationExpired = (WebSocketCloseStatus)4003;
    public const WebSocketCloseStatus SlowConsumer = (WebSocketCloseStatus)4008;
    public const WebSocketCloseStatus HeartbeatTimeout = (WebSocketCloseStatus)4009;
}

public interface IRealtimeServerTransport : IAsyncDisposable
{
    bool IsOpen { get; }

    ValueTask SendAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken);

    ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken);

    void Abort();
}

internal interface IInterruptibleRealtimeServerTransport
{
    void CancelPendingSend();
}

internal sealed class RealtimeWebSocketServerTransport(WebSocket socket) : IRealtimeServerTransport
{
    public WebSocket Socket { get; } = socket;

    public bool IsOpen => Socket.State == WebSocketState.Open;

    public ValueTask SendAsync(ReadOnlyMemory<byte> payload, CancellationToken cancellationToken) =>
        Socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken);

    public async ValueTask CloseAsync(WebSocketCloseStatus status, string description, CancellationToken cancellationToken)
    {
        if (Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await Socket.CloseOutputAsync(status, description, cancellationToken);
        }
    }

    public void Abort() => Socket.Abort();

    public ValueTask DisposeAsync()
    {
        Socket.Dispose();
        return ValueTask.CompletedTask;
    }
}

public sealed class RealtimeConnection : IAsyncDisposable
{
    private readonly IRealtimeServerTransport _transport;
    private readonly RealtimeOptions _options;
    private readonly GatewayMetrics _metrics;
    private readonly Channel<ServerMessageEnvelope> _outbound;
    private readonly ConcurrentDictionary<string, byte> _subscriptions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _correlations = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _correlationOrder = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly object _queueAccountingLock = new();
    private RealtimeIdentity _identity;
    private long _lastActivityTicks = DateTimeOffset.UtcNow.UtcTicks;
    private int _slowConsumerStrikes;
    private int _slowConsumerDisconnectRecorded;
    private int _closeRequested;
    private int _disposing;
    private int _queuedMessages;

    public RealtimeConnection(
        WebSocket socket,
        RealtimeIdentity identity,
        RealtimeOptions options,
        GatewayMetrics metrics,
        string? sessionId = null)
        : this(new RealtimeWebSocketServerTransport(socket), identity, options, metrics, sessionId)
    {
    }

    public RealtimeConnection(
        IRealtimeServerTransport transport,
        RealtimeIdentity identity,
        RealtimeOptions options,
        GatewayMetrics metrics,
        string? sessionId = null)
    {
        _transport = transport;
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

    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;

    public RealtimeIdentity Identity => Volatile.Read(ref _identity);

    public string? SessionId { get; }

    public WebSocket Socket => (_transport as RealtimeWebSocketServerTransport)?.Socket ??
        throw new InvalidOperationException("This connection does not use a WebSocket transport.");

    public DateTimeOffset LastActivity => new(Interlocked.Read(ref _lastActivityTicks), TimeSpan.Zero);

    public int SubscriptionCount => _subscriptions.Count;

    public int QueuedMessageCount => Math.Max(0, Volatile.Read(ref _queuedMessages));

    public bool IsOpen =>
        _transport.IsOpen &&
        Volatile.Read(ref _closeRequested) == 0 &&
        Volatile.Read(ref _disposing) == 0;

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

    public bool TrySubscribe(AuthorizedRoute route)
    {
        if (_subscriptions.Count >= _options.MaximumSubscriptions ||
            !_subscriptions.TryAdd(route.SubscriptionKey, 0))
        {
            return false;
        }
        _metrics.RecordSubscriptionAdded();
        return true;
    }

    public bool Unsubscribe(AuthorizedRoute route)
    {
        if (!_subscriptions.TryRemove(route.SubscriptionKey, out _))
        {
            return false;
        }
        _metrics.RecordSubscriptionsRemoved();
        return true;
    }

    public bool IsSubscribed(string topic, string? userId)
    {
        var key = userId is null ? $"topics/{topic}" : $"users/{userId}/topics/{topic}";
        return _subscriptions.ContainsKey(key);
    }

    public bool TryEnqueue(ServerMessageEnvelope message)
    {
        lock (_queueAccountingLock)
        {
            if (!IsOpen)
            {
                return false;
            }

            if (Volatile.Read(ref _queuedMessages) >= _options.OutboundQueueCapacity)
            {
                _metrics.RecordQueueDrop();
                Interlocked.Increment(ref _slowConsumerStrikes);
                return false;
            }

            Interlocked.Increment(ref _queuedMessages);
            _metrics.RecordQueueEnqueued();
            if (!_outbound.Writer.TryWrite(message))
            {
                RemoveQueuedMessage();
                if (IsOpen)
                {
                    _metrics.RecordQueueDrop();
                    Interlocked.Increment(ref _slowConsumerStrikes);
                }
                return false;
            }

            Interlocked.Exchange(ref _slowConsumerStrikes, 0);
            return true;
        }
    }

    public bool HasExceededSlowConsumerLimit =>
        Volatile.Read(ref _slowConsumerStrikes) >= _options.SlowConsumerStrikeLimit;

    public bool TryMarkSlowConsumerDisconnect() =>
        Interlocked.CompareExchange(ref _slowConsumerDisconnectRecorded, 1, 0) == 0;

    public async Task RunSenderAsync(CancellationToken cancellationToken)
    {
        await foreach (var message in _outbound.Reader.ReadAllAsync(cancellationToken))
        {
            var started = Stopwatch.GetTimestamp();
            var outcome = "failure";
            var lockTaken = false;
            try
            {
                var payload = JsonSerializer.SerializeToUtf8Bytes(
                    message,
                    RealtimeJsonSerializerContext.Default.ServerMessageEnvelope);
                await _sendLock.WaitAsync(cancellationToken);
                lockTaken = true;
                if (!_transport.IsOpen)
                {
                    return;
                }

                await _transport.SendAsync(payload, cancellationToken);
                _metrics.RecordMessage("outbound", "sent");
                outcome = "success";
            }
            catch (OperationCanceledException)
            {
                outcome = "cancelled";
                throw;
            }
            finally
            {
                _metrics.RecordHandlerDuration("send", Stopwatch.GetElapsedTime(started), outcome);
                if (lockTaken)
                {
                    _sendLock.Release();
                }
                RemoveQueuedMessage();
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
            if (_transport is IInterruptibleRealtimeServerTransport interruptible)
            {
                interruptible.CancelPendingSend();
            }
            await _sendLock.WaitAsync(cancellationToken);
            lockTaken = true;
            await _transport.CloseAsync(status, description, cancellationToken);
            _metrics.RecordCloseCode((int)status);
        }
        catch (Exception exception) when (exception is WebSocketException or IOException or ObjectDisposedException)
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
        _transport.Abort();
    }

    public async ValueTask DisposeAsync()
    {
        lock (_queueAccountingLock)
        {
            Volatile.Write(ref _disposing, 1);
            _outbound.Writer.TryComplete();
            _metrics.RecordQueueRemoved(Interlocked.Exchange(ref _queuedMessages, 0));
            _metrics.RecordSubscriptionsRemoved(_subscriptions.Count);
            _subscriptions.Clear();
        }
        if (_transport.IsOpen)
        {
            await RequestCloseAsync(WebSocketCloseStatus.NormalClosure, "connection_complete", CancellationToken.None);
        }

        await _transport.DisposeAsync();
        _sendLock.Dispose();
    }

    private void RemoveQueuedMessage()
    {
        lock (_queueAccountingLock)
        {
            while (true)
            {
                var queued = Volatile.Read(ref _queuedMessages);
                if (queued <= 0)
                {
                    return;
                }

                if (Interlocked.CompareExchange(ref _queuedMessages, queued - 1, queued) == queued)
                {
                    _metrics.RecordQueueDequeued();
                    return;
                }
            }
        }
    }
}
