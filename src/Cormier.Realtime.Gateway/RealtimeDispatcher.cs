using System.Diagnostics;
using System.Text.Json;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Redis;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class RealtimeDispatcher(
    IRealtimeMessageBus messageBus,
    IDurableRealtimeStore durableStore,
    RealtimeOptions options,
    GatewayOptions gatewayOptions,
    GatewayMetrics metrics)
{
    private static readonly ActivitySource Activities = new("Cormier.Realtime.Protocol");

    public async ValueTask DispatchAsync(
        RealtimeConnection connection,
        MessageEnvelope envelope,
        CancellationToken cancellationToken)
    {
        var started = Stopwatch.GetTimestamp();
        var outcome = "success";
        var redisOperation = "publish";
        var redisStarted = Stopwatch.GetTimestamp();
        try
        {
            using var activity = Activities.StartActivity("realtime.command", ActivityKind.Consumer);
            activity?.SetTag("messaging.operation", envelope.Type);
            activity?.SetTag("messaging.message.conversation_id", envelope.CorrelationId);

            if (string.Equals(envelope.Type, ProtocolMessageTypes.Ping, StringComparison.Ordinal))
            {
                connection.TryEnqueue(Acknowledge(envelope));
                return;
            }

            if (!RealtimeRouteAuthorizer.TryAuthorize(connection.Identity, envelope.Route, out var route))
            {
                outcome = "failure";
                metrics.RecordAuthorizationFailure(envelope.Type);
                connection.TryEnqueue(Error(
                    envelope,
                    ProtocolErrorCodes.Unauthorized,
                    "The server-derived identity is not authorized for this route."));
                return;
            }

            if (string.Equals(envelope.Type, ProtocolMessageTypes.Subscribe, StringComparison.Ordinal))
            {
                if (!connection.TrySubscribe(route))
                {
                    outcome = "failure";
                    connection.TryEnqueue(Error(
                        envelope,
                        ProtocolErrorCodes.InvalidEnvelope,
                        "Subscription limit reached or route already subscribed."));
                    return;
                }

                connection.TryEnqueue(Acknowledge(envelope));
                return;
            }

            if (string.Equals(envelope.Type, ProtocolMessageTypes.Unsubscribe, StringComparison.Ordinal))
            {
                connection.Unsubscribe(route);
                connection.TryEnqueue(Acknowledge(envelope));
                return;
            }

            if (!string.Equals(envelope.Type, ProtocolMessageTypes.Publish, StringComparison.Ordinal))
            {
                outcome = "failure";
                connection.TryEnqueue(Error(
                    envelope,
                    ProtocolErrorCodes.UnsupportedType,
                    "Unsupported command type."));
                return;
            }

            var busMessage = new RealtimeBusMessage(
                Guid.NewGuid().ToString("N"),
                connection.Identity.TenantId,
                route.UserId,
                route.Topic,
                envelope.CorrelationId,
                DateTimeOffset.UtcNow,
                envelope.Payload,
                BuildSourceInstance(gatewayOptions.ServiceName, Environment.MachineName));

            try
            {
                var eventClass = GetApprovedDurableEventClass(envelope.Payload);
                if (eventClass is not null)
                {
                    redisOperation = "stream_append";
                    redisStarted = Stopwatch.GetTimestamp();
                    await durableStore.AppendAsync(
                        new DurableStreamMessage(
                            eventClass,
                            busMessage.MessageId,
                            busMessage.TenantId,
                            busMessage.UserId,
                            busMessage.Topic,
                            busMessage.CorrelationId,
                            busMessage.Timestamp,
                            busMessage.Payload,
                            busMessage.SourceInstance),
                        cancellationToken);
                    metrics.RecordRedisOperation("stream_append", true);
                    metrics.RecordRedisDuration("stream_append", Stopwatch.GetElapsedTime(redisStarted), true);
                }

                redisOperation = "publish";
                redisStarted = Stopwatch.GetTimestamp();
                await messageBus.PublishAsync(busMessage, cancellationToken);
                metrics.RecordRedisOperation("publish", true);
                metrics.RecordRedisDuration("publish", Stopwatch.GetElapsedTime(redisStarted), true);
                connection.TryEnqueue(Acknowledge(envelope));
            }
            catch (RedisException)
            {
                outcome = "failure";
                metrics.RecordRedisOperation(redisOperation, false);
                metrics.RecordRedisDuration(redisOperation, Stopwatch.GetElapsedTime(redisStarted), false);
                connection.TryEnqueue(Error(
                    envelope,
                    ProtocolErrorCodes.InternalError,
                    "The messaging service is temporarily unavailable."));
            }
        }
        catch (OperationCanceledException)
        {
            outcome = "cancelled";
            throw;
        }
        catch
        {
            outcome = "failure";
            throw;
        }
        finally
        {
            metrics.RecordHandlerDuration("dispatch", Stopwatch.GetElapsedTime(started), outcome);
        }
    }

    private string? GetApprovedDurableEventClass(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("eventClass", out var eventClassElement) ||
            eventClassElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var eventClass = eventClassElement.GetString();
        return eventClass is not null && options.DurableEventClasses.Any(
            allowed => string.Equals(allowed, eventClass, StringComparison.Ordinal))
            ? eventClass
            : null;
    }

    public static string BuildSourceInstance(string serviceName, string machineName)
    {
        const int maximumLength = 256;
        ArgumentException.ThrowIfNullOrWhiteSpace(serviceName);
        ArgumentException.ThrowIfNullOrWhiteSpace(machineName);
        if (serviceName.Length > 128)
        {
            throw new ArgumentException("Service name must not exceed 128 characters.", nameof(serviceName));
        }

        var machineLength = Math.Min(
            machineName.Length,
            maximumLength - serviceName.Length - 1);
        return $"{serviceName}:{machineName[..machineLength]}";
    }

    private static ServerMessageEnvelope Acknowledge(MessageEnvelope envelope) =>
        new(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Acknowledge,
            envelope.CorrelationId,
            DateTimeOffset.UtcNow,
            envelope.Route);

    public static ServerMessageEnvelope Error(
        MessageEnvelope? envelope,
        string code,
        string message) =>
        new(
            ProtocolVersions.Current,
            ProtocolMessageTypes.Error,
            envelope?.CorrelationId ?? Guid.NewGuid().ToString("N"),
            DateTimeOffset.UtcNow,
            envelope?.Route ?? "system/error",
            Error: new ProtocolError(code, message));
}
