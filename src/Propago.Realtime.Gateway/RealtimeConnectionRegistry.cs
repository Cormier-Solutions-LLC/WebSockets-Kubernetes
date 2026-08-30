using System.Collections.Concurrent;
using Propago.Realtime.Contracts;

namespace Propago.Realtime.Gateway;

public sealed class RealtimeConnectionRegistry(GatewayMetrics metrics)
{
    private static readonly ReconnectAdvice RestartAdvice = new(500, 30_000, 0.2, true);
    private readonly ConcurrentDictionary<string, RealtimeConnection> _connections = new(StringComparer.Ordinal);

    public int Count => _connections.Count;

    public bool Add(RealtimeConnection connection)
    {
        if (!_connections.TryAdd(connection.Id, connection))
        {
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
            if (!string.Equals(connection.Identity.TenantId, message.TenantId, StringComparison.Ordinal) ||
                message.UserId is not null &&
                !string.Equals(connection.Identity.UserId, message.UserId, StringComparison.Ordinal) ||
                !connection.IsSubscribed(message.Topic, message.UserId))
            {
                continue;
            }

            if (!connection.TryEnqueue(envelope) && connection.HasExceededSlowConsumerLimit)
            {
                await connection.RequestCloseAsync(
                    RealtimeCloseStatus.SlowConsumer,
                    "slow_consumer",
                    cancellationToken);
            }
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
