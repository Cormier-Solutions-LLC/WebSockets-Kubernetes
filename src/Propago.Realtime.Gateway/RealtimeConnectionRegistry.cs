using System.Collections.Concurrent;
using System.Net.WebSockets;
using Propago.Realtime.Contracts;
using StackExchange.Redis;

namespace Propago.Realtime.Gateway;

public sealed class RealtimeConnectionRegistry(
    GatewayMetrics metrics,
    RealtimeAuthenticator? authenticator = null)
{
    private static readonly ReconnectAdvice RestartAdvice = new(500, 30_000, 0.2, true);
    private readonly ConcurrentDictionary<string, RealtimeConnection> _connections = new(StringComparer.Ordinal);
    private int _draining;

    public int Count => _connections.Count;

    public bool IsDraining => Volatile.Read(ref _draining) == 1;

    public void BeginDrain() => Interlocked.Exchange(ref _draining, 1);

    public bool Add(RealtimeConnection connection)
    {
        if (IsDraining)
        {
            return false;
        }

        if (!_connections.TryAdd(connection.Id, connection))
        {
            return false;
        }

        if (IsDraining)
        {
            _connections.TryRemove(connection.Id, out _);
            return false;
        }

        metrics.RecordConnectionOpened();
        return true;
    }

    public bool Remove(string connectionId, string reason)
    {
        if (!_connections.TryRemove(connectionId, out _))
        {
            return false;
        }

        metrics.RecordConnectionClosed(reason);
        return true;
    }

    public async ValueTask DeliverAsync(RealtimeBusMessage message, CancellationToken cancellationToken)
    {
        List<Task>? closeTasks = null;
        var envelope = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Event,
            message.CorrelationId,
            message.Timestamp,
            message.UserId is null
                ? $"topics/{message.Topic}"
                : $"users/{message.UserId}/topics/{message.Topic}",
            message.Payload);

        foreach (var connection in _connections.Values)
        {
            var identity = connection.Identity;
            if (connection.SessionId is not null && authenticator is not null)
            {
                try
                {
                    var refreshed = await authenticator.RevalidateSessionAsync(
                        connection.SessionId,
                        cancellationToken);
                    if (refreshed is null ||
                        !string.Equals(refreshed.TenantId, identity.TenantId, StringComparison.Ordinal) ||
                        !string.Equals(refreshed.UserId, identity.UserId, StringComparison.Ordinal))
                    {
                        AddBoundedClose(
                            ref closeTasks,
                            connection,
                            RealtimeCloseStatus.AuthenticationExpired,
                            "authentication_expired",
                            cancellationToken);
                        continue;
                    }

                    connection.UpdateIdentity(refreshed);
                    identity = refreshed;
                }
                catch (RedisException)
                {
                    AddBoundedClose(
                        ref closeTasks,
                        connection,
                        WebSocketCloseStatus.InternalServerError,
                        "authentication_unavailable",
                        cancellationToken);
                    continue;
                }
            }

            if (DateTimeOffset.UtcNow >= identity.ExpiresAt)
            {
                AddBoundedClose(
                    ref closeTasks,
                    connection,
                    RealtimeCloseStatus.AuthenticationExpired,
                    "authentication_expired",
                    cancellationToken);
                continue;
            }

            if (!string.Equals(identity.TenantId, message.TenantId, StringComparison.Ordinal) ||
                message.UserId is not null &&
                !string.Equals(identity.UserId, message.UserId, StringComparison.Ordinal) ||
                !identity.AllowedTopics.Any(allowed =>
                    allowed == "*" || string.Equals(allowed, message.Topic, StringComparison.Ordinal)) ||
                !connection.IsSubscribed(message.Topic, message.UserId))
            {
                continue;
            }

            if (!connection.TryEnqueue(envelope) && connection.HasExceededSlowConsumerLimit)
            {
                AddBoundedClose(
                    ref closeTasks,
                    connection,
                    RealtimeCloseStatus.SlowConsumer,
                    "slow_consumer",
                    cancellationToken);
            }
        }

        if (closeTasks is not null)
        {
            await Task.WhenAll(closeTasks);
        }
    }

    private static void AddBoundedClose(
        ref List<Task>? closeTasks,
        RealtimeConnection connection,
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken)
    {
        closeTasks ??= [];
        closeTasks.Add(CloseWithinTimeoutAsync(
            connection,
            status,
            description,
            cancellationToken));
    }

    private static async Task CloseWithinTimeoutAsync(
        RealtimeConnection connection,
        WebSocketCloseStatus status,
        string description,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(1));
        try
        {
            await connection.RequestCloseAsync(status, description, timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            connection.Abort(status);
        }
    }

    public ValueTask NotifyServiceRestartAsync()
    {
        var message = new ServerMessageEnvelope(
            ProtocolVersions.Current,
            ProtocolMessageTypes.ServiceRestart,
            Guid.NewGuid().ToString("N"),
            DateTimeOffset.UtcNow,
            "system/restart",
            Reconnect: RestartAdvice);
        foreach (var connection in _connections.Values)
        {
            connection.TryEnqueue(message);
        }

        return ValueTask.CompletedTask;
    }

    public async ValueTask CloseAllAsync(CancellationToken cancellationToken)
    {
        foreach (var connection in _connections.Values)
        {
            await connection.RequestCloseAsync(
                RealtimeCloseStatus.ServiceRestart,
                "service_restart",
                cancellationToken);
        }
    }
}
