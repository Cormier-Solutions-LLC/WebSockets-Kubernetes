using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.Text;
using Microsoft.Extensions.Options;
using Cormier.Realtime.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class GatewayState(
    IRedisReadinessProbe redisProbe,
    IOptions<RedisOptions> redisOptions,
    RedisSubscriptionState subscriptionState)
{
    private int _started;
    private int _draining;

    public bool IsStarted => Volatile.Read(ref _started) == 1;

    public bool IsDraining => Volatile.Read(ref _draining) == 1;

    public void MarkStarted() => Interlocked.Exchange(ref _started, 1);

    public void BeginDrain() => Interlocked.Exchange(ref _draining, 1);

    public async ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        if (!IsStarted || IsDraining || !subscriptionState.IsActive)
        {
            return false;
        }

        var dependenciesReady = !redisOptions.Value.RequiredForReadiness ||
            await redisProbe.IsReadyAsync(cancellationToken);

        return dependenciesReady && !IsDraining;
    }
}

public sealed class RedisSubscriptionState
{
    private int _active;

    public bool IsActive => Volatile.Read(ref _active) == 1;

    public void MarkActive() => Interlocked.Exchange(ref _active, 1);

    public void MarkInactive() => Interlocked.Exchange(ref _active, 0);
}

public sealed class GatewayMetrics : IDisposable
{
    private static readonly double[] DurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];
    private static readonly HashSet<string> Directions = new(StringComparer.Ordinal) { "inbound", "outbound" };
    private static readonly HashSet<string> MessageOutcomes = new(StringComparer.Ordinal) { "accepted", "sent", "malformed", "invalid", "duplicate", "rejected", "error" };
    private static readonly HashSet<string> AuthenticationMethods = new(StringComparer.Ordinal) { "session", "ticket", "origin" };
    private static readonly HashSet<string> RedisOperations = new(StringComparer.Ordinal) { "publish", "subscribe", "stream_append", "stream_ack", "stream_claim", "session_read", "ticket_issue", "ticket_consume" };
    private readonly ConcurrentDictionary<string, long> _series = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, HistogramState> _histograms = new(StringComparer.Ordinal);
    private readonly Meter _meter = new(
        "Cormier.Realtime.Gateway",
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
    private readonly Counter<long> _handlerCancellations;
    private readonly Counter<long> _drainTransitions;
    private long _healthRequestCount;
    private long _activeConnections;
    private long _peakConnections;
    private long _queueDepth;
    private long _peakQueueDepth;
    private long _messageCount;
    private long _authenticationFailures;
    private long _authorizationFailureCount;
    private long _queueDropCount;
    private long _redisErrorCount;
    private long _closeCount;
    private long _handlerCancellationCount;
    private long _draining;
    private long _redisSubscriptionActive;

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
        _handlerCancellations = _meter.CreateCounter<long>("gateway.handlers.cancelled");
        _drainTransitions = _meter.CreateCounter<long>("gateway.drain.transitions");
    }

    public long HealthRequestCount => Interlocked.Read(ref _healthRequestCount);

    public long ActiveConnections => Interlocked.Read(ref _activeConnections);

    public long PeakConnections => Interlocked.Read(ref _peakConnections);

    public void RecordHealthRequest(string endpoint)
    {
        Interlocked.Increment(ref _healthRequestCount);
        Increment("cormier_realtime_health_requests_total", ("endpoint", Normalize(endpoint, "startup", "live", "ready")));
        _healthRequests.Add(1, new KeyValuePair<string, object?>("endpoint", endpoint));
    }

    public void RecordConnectionOpened()
    {
        var active = Interlocked.Increment(ref _activeConnections);
        UpdateMaximum(ref _peakConnections, active);
        Increment("cormier_realtime_connections_opened_total");
        _connectionsOpened.Add(1);
    }

    public void RecordConnectionClosed(string reason, TimeSpan? duration = null)
    {
        if (Interlocked.Decrement(ref _activeConnections) < 0)
        {
            Interlocked.Exchange(ref _activeConnections, 0);
        }
        var normalizedReason = Normalize(reason, "client_disconnect", "client_close", "cancelled", "abrupt_disconnect", "socket_closed", "service_restart", "authentication_expired", "authentication_invalid", "authentication_unavailable", "heartbeat_timeout", "slow_consumer", "invalid_message_type", "message_too_large", "fragmented_message");
        Increment("cormier_realtime_connections_closed_total", ("reason", normalizedReason));
        if (duration is not null)
        {
            Observe("cormier_realtime_connection_duration_seconds", duration.Value.TotalSeconds, ("reason", normalizedReason));
        }
        _connectionsClosed.Add(1, new KeyValuePair<string, object?>("reason", normalizedReason));
    }

    public void RecordMessage(string direction, string outcome)
    {
        Interlocked.Increment(ref _messageCount);
        direction = Directions.Contains(direction) ? direction : "other";
        outcome = MessageOutcomes.Contains(outcome) ? outcome : "other";
        Increment("cormier_realtime_messages_total", ("direction", direction), ("outcome", outcome));
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

        method = AuthenticationMethods.Contains(method) ? method : "other";
        Increment("cormier_realtime_authentication_total", ("method", method), ("outcome", succeeded ? "success" : "failure"));
        _authentication.Add(
            1,
            new KeyValuePair<string, object?>("method", method),
            new KeyValuePair<string, object?>("outcome", succeeded ? "success" : "failure"));
    }

    public void RecordAuthorizationFailure(string operation)
    {
        Interlocked.Increment(ref _authorizationFailureCount);
        operation = Normalize(operation, "publish", "subscribe", "unsubscribe", "ping");
        Increment("cormier_realtime_authorization_failures_total", ("operation", operation));
        _authorizationFailures.Add(1, new KeyValuePair<string, object?>("operation", operation));
    }

    public void RecordQueueDrop()
    {
        Interlocked.Increment(ref _queueDropCount);
        _queueDrops.Add(1);
    }

    public void RecordQueueEnqueued()
    {
        var depth = Interlocked.Increment(ref _queueDepth);
        UpdateMaximum(ref _peakQueueDepth, depth);
    }

    public void RecordQueueDequeued()
    {
        if (Interlocked.Decrement(ref _queueDepth) < 0)
        {
            Interlocked.Exchange(ref _queueDepth, 0);
        }
    }

    public void RecordQueueRemoved(int count)
    {
        if (count <= 0) return;
        var depth = Interlocked.Add(ref _queueDepth, -count);
        if (depth < 0) Interlocked.Exchange(ref _queueDepth, 0);
    }

    public void RecordSlowConsumerDisconnect() => Increment("cormier_realtime_slow_consumer_disconnects_total");

    public void RecordHeartbeatTimeout() => Increment("cormier_realtime_heartbeat_timeouts_total");

    public void RecordHandshake(string outcome, string reason)
    {
        outcome = Normalize(outcome, "accepted", "rejected");
        reason = Normalize(reason, "accepted", "draining", "not_websocket", "subprotocol", "authentication", "registration");
        Increment("cormier_realtime_handshakes_total", ("outcome", outcome), ("reason", reason));
    }

    public void RecordHandlerDuration(string operation, TimeSpan duration, string outcome)
    {
        operation = Normalize(operation, "receive", "dispatch", "send");
        outcome = Normalize(outcome, "success", "failure", "cancelled");
        Observe("cormier_realtime_handler_duration_seconds", duration.TotalSeconds, ("operation", operation), ("outcome", outcome));
    }

    public void RecordRedisOperation(string operation, bool succeeded)
    {
        if (!succeeded)
        {
            Interlocked.Increment(ref _redisErrorCount);
        }

        operation = RedisOperations.Contains(operation) ? operation : "other";
        Increment("cormier_realtime_redis_operations_total", ("operation", operation), ("outcome", succeeded ? "success" : "failure"));
        _redisOperations.Add(
            1,
            new KeyValuePair<string, object?>("operation", operation),
            new KeyValuePair<string, object?>("outcome", succeeded ? "success" : "failure"));
    }

    public void RecordRedisDuration(string operation, TimeSpan duration, bool succeeded)
    {
        operation = RedisOperations.Contains(operation) ? operation : "other";
        Observe("cormier_realtime_redis_operation_duration_seconds", duration.TotalSeconds, ("operation", operation), ("outcome", succeeded ? "success" : "failure"));
    }

    public void RecordRedisSubscriptionState(bool active) => Interlocked.Exchange(ref _redisSubscriptionActive, active ? 1 : 0);

    public void RecordCloseCode(int status)
    {
        Interlocked.Increment(ref _closeCount);
        _closeCodes.Add(1, new KeyValuePair<string, object?>("code", status));
        Increment("cormier_realtime_websocket_closes_total", ("code", status.ToString(CultureInfo.InvariantCulture)));
    }

    public void RecordHandlerCancellation()
    {
        Interlocked.Increment(ref _handlerCancellationCount);
        _handlerCancellations.Add(1);
        Increment("cormier_realtime_handler_cancellations_total");
    }

    public void RecordDrainStarted()
    {
        Interlocked.Exchange(ref _draining, 1);
        _drainTransitions.Add(1);
    }

    public string RenderPrometheus()
    {
        var builder = new StringBuilder(4096);
        AppendGauge(builder, "cormier_realtime_active_connections", "Current WebSocket connections.", ActiveConnections);
        AppendGauge(builder, "cormier_realtime_peak_connections", "Peak WebSocket connections since process start.", PeakConnections);
        AppendGauge(builder, "cormier_realtime_queue_depth", "Current queued outbound messages.", Interlocked.Read(ref _queueDepth));
        AppendGauge(builder, "cormier_realtime_queue_peak_depth", "Peak queued outbound messages since process start.", Interlocked.Read(ref _peakQueueDepth));
        AppendGauge(builder, "cormier_realtime_draining", "Whether the gateway is draining.", Interlocked.Read(ref _draining));
        AppendGauge(builder, "cormier_realtime_redis_subscription_active", "Whether the Redis Pub/Sub subscription is active.", Interlocked.Read(ref _redisSubscriptionActive));

        foreach (var counter in new[]
        {
            "cormier_realtime_health_requests_total", "cormier_realtime_connections_opened_total",
            "cormier_realtime_connections_closed_total", "cormier_realtime_messages_total",
            "cormier_realtime_authentication_total", "cormier_realtime_authentication_failures_total",
            "cormier_realtime_authorization_failures_total", "cormier_realtime_queue_dropped_total",
            "cormier_realtime_slow_consumer_disconnects_total", "cormier_realtime_heartbeat_timeouts_total",
            "cormier_realtime_handshakes_total", "cormier_realtime_redis_operations_total",
            "cormier_realtime_redis_errors_total", "cormier_realtime_websocket_closes_total",
            "cormier_realtime_handler_cancellations_total",
        })
        {
            AppendType(builder, counter, "counter");
        }
        AppendType(builder, "cormier_realtime_connection_duration_seconds", "histogram");
        AppendType(builder, "cormier_realtime_handler_duration_seconds", "histogram");
        AppendType(builder, "cormier_realtime_redis_operation_duration_seconds", "histogram");

        foreach (var series in _series.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            builder.Append(series.Key).Append(' ').Append(series.Value.ToString(CultureInfo.InvariantCulture)).Append('\n');
        }

        // Compatibility totals retained for pre-dashboard consumers.
        AppendSample(builder, "cormier_realtime_queue_dropped_total", Interlocked.Read(ref _queueDropCount));
        AppendSample(builder, "cormier_realtime_websocket_closes_total", Interlocked.Read(ref _closeCount));
        AppendSample(builder, "cormier_realtime_authentication_failures_total", Interlocked.Read(ref _authenticationFailures));
        AppendSample(builder, "cormier_realtime_redis_errors_total", Interlocked.Read(ref _redisErrorCount));
        foreach (var histogram in _histograms.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            histogram.Value.Render(builder, histogram.Key);
        }
        return builder.ToString();
    }

    private void Increment(string name, params (string Name, string Value)[] labels) =>
        _series.AddOrUpdate(Series(name, labels), 1, static (_, current) => current + 1);

    private void Observe(string name, double value, params (string Name, string Value)[] labels) =>
        _histograms.GetOrAdd(Series(name, labels), static _ => new HistogramState()).Observe(value);

    private static string Series(string name, params (string Name, string Value)[] labels) => labels.Length == 0
        ? name
        : $"{name}{{{string.Join(',', labels.Select(label => $"{label.Name}=\"{Escape(label.Value)}\""))}}}";

    private static string Escape(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal);

    private static string Normalize(string value, params string[] allowed) => allowed.Contains(value, StringComparer.Ordinal) ? value : "other";

    private static void UpdateMaximum(ref long target, long candidate)
    {
        var current = Interlocked.Read(ref target);
        while (candidate > current)
        {
            var observed = Interlocked.CompareExchange(ref target, candidate, current);
            if (observed == current) return;
            current = observed;
        }
    }

    private static void AppendGauge(StringBuilder builder, string name, string help, long value) => builder.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n').Append("# TYPE ").Append(name).Append(" gauge\n").Append(name).Append(' ').Append(value.ToString(CultureInfo.InvariantCulture)).Append('\n');

    private static void AppendType(StringBuilder builder, string name, string type) => builder.Append("# HELP ").Append(name).Append(" Realtime gateway operational metric.\n").Append("# TYPE ").Append(name).Append(' ').Append(type).Append('\n');

    private static void AppendSample(StringBuilder builder, string name, long value) => builder.Append(name).Append(' ').Append(value.ToString(CultureInfo.InvariantCulture)).Append('\n');

    private sealed class HistogramState
    {
        private readonly long[] _buckets = new long[DurationBuckets.Length];
        private long _count;
        private double _sum;

        public void Observe(double value)
        {
            lock (_buckets)
            {
                _count++;
                _sum += value;
                for (var i = 0; i < DurationBuckets.Length; i++) if (value <= DurationBuckets[i]) _buckets[i]++;
            }
        }

        public void Render(StringBuilder builder, string series)
        {
            var brace = series.IndexOf('{');
            var name = brace < 0 ? series : series[..brace];
            var labels = brace < 0 ? string.Empty : series[(brace + 1)..^1];
            lock (_buckets)
            {
                for (var i = 0; i < DurationBuckets.Length; i++) builder.Append(name).Append("_bucket{").Append(labels).Append(labels.Length == 0 ? string.Empty : ",").Append("le=\"").Append(DurationBuckets[i].ToString(CultureInfo.InvariantCulture)).Append("\"} ").Append(_buckets[i]).Append('\n');
                builder.Append(name).Append("_bucket{").Append(labels).Append(labels.Length == 0 ? string.Empty : ",").Append("le=\"+Inf\"} ").Append(_count).Append('\n');
                builder.Append(name).Append("_sum").Append(brace < 0 ? string.Empty : $"{{{labels}}}").Append(' ').Append(_sum.ToString(CultureInfo.InvariantCulture)).Append('\n');
                builder.Append(name).Append("_count").Append(brace < 0 ? string.Empty : $"{{{labels}}}").Append(' ').Append(_count).Append('\n');
            }
        }
    }

    public void Dispose() => _meter.Dispose();
}
