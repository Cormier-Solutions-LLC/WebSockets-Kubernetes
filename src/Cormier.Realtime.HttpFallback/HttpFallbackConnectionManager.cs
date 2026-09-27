using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using StackExchange.Redis;

namespace Cormier.Realtime.HttpFallback;

internal sealed class HttpFallbackConnectionManager(
    RealtimeConnectionRegistry registry,
    RealtimeAuthenticator authenticator,
    RealtimeDispatcher dispatcher,
    RealtimeOptions realtimeOptions,
    HttpFallbackOptions options,
    GatewayState gatewayState,
    GatewayMetrics metrics)
{
    private readonly ConcurrentDictionary<string, State> _connections = new(StringComparer.Ordinal);

    public State? Create(AuthenticationResult authentication)
    {
        if (gatewayState.IsDraining || registry.IsDraining)
        {
            return null;
        }
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var transport = new HttpFallbackTransport(realtimeOptions.OutboundQueueCapacity);
        var connection = new RealtimeConnection(
            transport,
            authentication.Identity!,
            realtimeOptions,
            metrics,
            authentication.SessionId);
        var state = new State(id, token, connection, transport);
        if (!_connections.TryAdd(id, state))
        {
            connection.Abort(WebSocketCloseStatus.InternalServerError);
            return null;
        }
        if (!registry.Add(connection))
        {
            _connections.TryRemove(id, out _);
            connection.Abort(WebSocketCloseStatus.InternalServerError);
            return null;
        }
        state.Background = RunAsync(state);
        return state;
    }

    public bool TryGet(string id, string token, out State state)
    {
        if (!_connections.TryGetValue(id, out state!))
        {
            return false;
        }
        var expected = Encoding.ASCII.GetBytes(state.Token);
        var supplied = Encoding.ASCII.GetBytes(token);
        return expected.Length == supplied.Length && CryptographicOperations.FixedTimeEquals(expected, supplied);
    }

    public async Task<bool> DispatchAsync(State state, MessageEnvelope envelope, CancellationToken cancellationToken)
    {
        var validation = ProtocolValidator.Validate(envelope, DateTimeOffset.UtcNow);
        if (!validation.IsValid)
        {
            state.Connection.TryEnqueue(RealtimeDispatcher.Error(envelope, validation.ErrorCode!, validation.ErrorMessage!));
            return true;
        }
        if (!await RevalidateAsync(state, cancellationToken))
        {
            await CloseAsync(state, "authentication_invalid", cancellationToken);
            return false;
        }
        state.Connection.RecordActivity();
        if (!state.Connection.TryTrackCorrelation(envelope.CorrelationId))
        {
            state.Connection.TryEnqueue(RealtimeDispatcher.Error(
                envelope,
                ProtocolErrorCodes.DuplicateCorrelation,
                "CorrelationId has already been processed on this connection."));
            return true;
        }
        await dispatcher.DispatchAsync(state.Connection, envelope, cancellationToken);
        return true;
    }

    public async Task CloseAsync(State state, string reason, CancellationToken cancellationToken)
    {
        if (!_connections.TryRemove(state.Id, out _))
        {
            return;
        }
        registry.Remove(state.Connection.Id, reason);
        state.Lifetime.Cancel();
        try
        {
            await state.Connection.RequestCloseAsync(WebSocketCloseStatus.NormalClosure, reason, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            state.Connection.Abort(WebSocketCloseStatus.NormalClosure);
        }
        await state.Connection.DisposeAsync();
    }

    private async Task RunAsync(State state)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(realtimeOptions.HeartbeatSeconds));
        try
        {
            var sender = state.Connection.RunSenderAsync(state.Lifetime.Token);
            await Task.Delay(TimeSpan.FromSeconds(options.ConnectionTimeoutSeconds), state.Lifetime.Token);
            if (!state.StreamAttached)
            {
                await CloseAsync(state, "http_stream_timeout", CancellationToken.None);
                await sender;
                return;
            }
            while (await timer.WaitForNextTickAsync(state.Lifetime.Token))
            {
                if (!await RevalidateAsync(state, state.Lifetime.Token) ||
                    DateTimeOffset.UtcNow - state.Connection.LastActivity > TimeSpan.FromSeconds(realtimeOptions.IdleTimeoutSeconds))
                {
                    break;
                }
                state.Connection.TryEnqueue(new ServerMessageEnvelope(
                    ProtocolVersions.Current,
                    ProtocolMessageTypes.Ping,
                    Guid.NewGuid().ToString("N"),
                    DateTimeOffset.UtcNow,
                    "system/heartbeat"));
            }
            await CloseAsync(state, "http_connection_complete", CancellationToken.None);
            await sender;
        }
        catch (OperationCanceledException) when (state.Lifetime.IsCancellationRequested)
        {
        }
    }

    private async Task<bool> RevalidateAsync(State state, CancellationToken cancellationToken)
    {
        if (DateTimeOffset.UtcNow >= state.Connection.Identity.ExpiresAt)
        {
            return false;
        }
        if (state.Connection.SessionId is null)
        {
            return true;
        }
        try
        {
            var identity = await authenticator.RevalidateSessionAsync(state.Connection.SessionId, cancellationToken);
            if (identity is null ||
                !string.Equals(identity.TenantId, state.Connection.Identity.TenantId, StringComparison.Ordinal) ||
                !string.Equals(identity.UserId, state.Connection.Identity.UserId, StringComparison.Ordinal))
            {
                return false;
            }
            state.Connection.UpdateIdentity(identity);
            return true;
        }
        catch (RedisException)
        {
            return false;
        }
    }

    internal sealed class State(
        string id,
        string token,
        RealtimeConnection connection,
        HttpFallbackTransport transport)
    {
        private int _streamAttached;
        public string Id { get; } = id;
        public string Token { get; } = token;
        public RealtimeConnection Connection { get; } = connection;
        public HttpFallbackTransport Transport { get; } = transport;
        public CancellationTokenSource Lifetime { get; } = new();
        public Task Background { get; set; } = Task.CompletedTask;
        public bool StreamAttached => Volatile.Read(ref _streamAttached) == 1;
        public bool TryAttachStream() => Interlocked.CompareExchange(ref _streamAttached, 1, 0) == 0;
        public SemaphoreSlim ReceiveGate { get; } = new(1, 1);
        public void MarkClientAttached() => Interlocked.Exchange(ref _streamAttached, 1);
    }
}
