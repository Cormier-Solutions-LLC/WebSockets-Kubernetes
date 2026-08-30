using System.Diagnostics.Metrics;
using Microsoft.Extensions.Options;
using Propago.Realtime.Redis;

namespace Propago.Realtime.Gateway;

public sealed class GatewayState(
    IRedisReadinessProbe redisProbe,
    IOptions<RedisOptions> redisOptions)
{
    private int _started;
    private int _draining;

    public bool IsStarted => Volatile.Read(ref _started) == 1;

    public bool IsDraining => Volatile.Read(ref _draining) == 1;

    public void MarkStarted() => Interlocked.Exchange(ref _started, 1);

    public void BeginDrain() => Interlocked.Exchange(ref _draining, 1);

    public async ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        if (!IsStarted || IsDraining)
        {
            return false;
        }

        var dependenciesReady = !redisOptions.Value.RequiredForReadiness ||
            await redisProbe.IsReadyAsync(cancellationToken);

        return dependenciesReady && !IsDraining;
    }
}

public sealed class GatewayMetrics : IDisposable
{
    private readonly Meter _meter = new(
        "Propago.Realtime.Gateway",
        typeof(GatewayMetrics).Assembly.GetName().Version?.ToString(3));
    private readonly Counter<long> _healthRequests;
    private readonly Counter<long> _connectionsOpened;
    private readonly Counter<long> _connectionsClosed;
    private readonly Counter<long> _messages;
    private readonly Counter<long> _authentication;
    private readonly Counter<long> _authorizationFailures;
    private readonly Counter<long> _queueDrops;
    private readonly Counter<long> _redisOperations;
    private readonly Counter<long> _closeCodes;
    private long _healthRequestCount;
    private long _activeConnections;
    private long _messageCount;
    private long _authenticationFailures;
    private long _authorizationFailureCount;
    private long _queueDropCount;
    private long _redisErrorCount;
    private long _closeCount;

    public GatewayMetrics()
    {
        _healthRequests = _meter.CreateCounter<long>("gateway.health.requests");
        _connectionsOpened = _meter.CreateCounter<long>("gateway.connections.opened");
        _connectionsClosed = _meter.CreateCounter<long>("gateway.connections.closed");
        _messages = _meter.CreateCounter<long>("gateway.messages");
        _authentication = _meter.CreateCounter<long>("gateway.authentication");
        _authorizationFailures = _meter.CreateCounter<long>("gateway.authorization.failures");
        _queueDrops = _meter.CreateCounter<long>("gateway.queue.dropped");
        _redisOperations = _meter.CreateCounter<long>("gateway.redis.operations");
        _closeCodes = _meter.CreateCounter<long>("gateway.websocket.closes");
    }

    public long HealthRequestCount => Interlocked.Read(ref _healthRequestCount);

    public long ActiveConnections => Interlocked.Read(ref _activeConnections);

    public void RecordHealthRequest(string endpoint)
    {
        Interlocked.Increment(ref _healthRequestCount);
        _healthRequests.Add(1, new KeyValuePair<string, object?>("endpoint", endpoint));
    }

    public void RecordConnectionOpened()
    {
        Interlocked.Increment(ref _activeConnections);
        _connectionsOpened.Add(1);
    }

    public void RecordConnectionClosed(string reason)
    {
        Interlocked.Decrement(ref _activeConnections);
        _connectionsClosed.Add(1, new KeyValuePair<string, object?>("reason", reason));
    }

    public void RecordMessage(string direction, string outcome)
    {
        Interlocked.Increment(ref _messageCount);
        _messages.Add(
            1,
            new KeyValuePair<string, object?>("direction", direction),
            new KeyValuePair<string, object?>("outcome", outcome));
    }

    public void RecordAuthentication(bool succeeded, string method)
    {
        if (!succeeded)
        {
            Interlocked.Increment(ref _authenticationFailures);
        }

        _authentication.Add(
            1,
            new KeyValuePair<string, object?>("method", method),
            new KeyValuePair<string, object?>("outcome", succeeded ? "success" : "failure"));
    }

    public void RecordAuthorizationFailure(string operation)
    {
        Interlocked.Increment(ref _authorizationFailureCount);
        _authorizationFailures.Add(1, new KeyValuePair<string, object?>("operation", operation));
    }

    public void RecordQueueDrop()
    {
        Interlocked.Increment(ref _queueDropCount);
        _queueDrops.Add(1);
    }

    public void RecordRedisOperation(string operation, bool succeeded)
    {
        if (!succeeded)
        {
            Interlocked.Increment(ref _redisErrorCount);
        }

        _redisOperations.Add(
            1,
            new KeyValuePair<string, object?>("operation", operation),
            new KeyValuePair<string, object?>("outcome", succeeded ? "success" : "failure"));
    }

    public void RecordCloseCode(int status)
    {
        Interlocked.Increment(ref _closeCount);
        _closeCodes.Add(1, new KeyValuePair<string, object?>("code", status));
    }

    public string RenderPrometheus() =>
        "# HELP propago_realtime_health_requests_total Health endpoint requests.\n" +
        "# TYPE propago_realtime_health_requests_total counter\n" +
        $"propago_realtime_health_requests_total {HealthRequestCount}\n" +
        "# HELP propago_realtime_active_connections Current WebSocket connections.\n" +
        "# TYPE propago_realtime_active_connections gauge\n" +
        $"propago_realtime_active_connections {ActiveConnections}\n" +
        "# TYPE propago_realtime_messages_total counter\n" +
        $"propago_realtime_messages_total {Interlocked.Read(ref _messageCount)}\n" +
        "# TYPE propago_realtime_authentication_failures_total counter\n" +
        $"propago_realtime_authentication_failures_total {Interlocked.Read(ref _authenticationFailures)}\n" +
        "# TYPE propago_realtime_authorization_failures_total counter\n" +
        $"propago_realtime_authorization_failures_total {Interlocked.Read(ref _authorizationFailureCount)}\n" +
        "# TYPE propago_realtime_queue_dropped_total counter\n" +
        $"propago_realtime_queue_dropped_total {Interlocked.Read(ref _queueDropCount)}\n" +
        "# TYPE propago_realtime_redis_errors_total counter\n" +
        $"propago_realtime_redis_errors_total {Interlocked.Read(ref _redisErrorCount)}\n" +
        "# TYPE propago_realtime_websocket_closes_total counter\n" +
        $"propago_realtime_websocket_closes_total {Interlocked.Read(ref _closeCount)}\n";

    public void Dispose() => _meter.Dispose();
}
