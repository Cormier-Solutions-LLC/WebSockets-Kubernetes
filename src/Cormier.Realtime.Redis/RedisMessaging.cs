using System.Text.Json;
using Cormier.Realtime.Contracts;
using StackExchange.Redis;

namespace Cormier.Realtime.Redis;

public interface IRealtimeMessageBus
{
    ValueTask PublishAsync(RealtimeBusMessage message, CancellationToken cancellationToken);

    ValueTask<IAsyncDisposable> SubscribeAsync(
        Func<RealtimeBusMessage, ValueTask> handler,
        CancellationToken cancellationToken);
}

public sealed class RedisRealtimeMessageBus(
    RedisConnectionProvider connectionProvider,
    RedisOptions options) : IRealtimeMessageBus
{
    public async ValueTask PublishAsync(RealtimeBusMessage message, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var json = JsonSerializer.Serialize(
            message,
            RealtimeJsonSerializerContext.Default.RealtimeBusMessage);
        await connection.GetSubscriber().PublishAsync(Channel(), json);
    }

    public async ValueTask<IAsyncDisposable> SubscribeAsync(
        Func<RealtimeBusMessage, ValueTask> handler,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(handler);
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var subscriber = connection.GetSubscriber();
        var queue = await subscriber.SubscribeAsync(Channel());
        queue.OnMessage(async message =>
        {
            try
            {
                var parsed = JsonSerializer.Deserialize(
                    message.Message.ToString(),
                    RealtimeJsonSerializerContext.Default.RealtimeBusMessage);
                if (parsed is not null && IsValidBusMessage(parsed))
                {
                    await handler(parsed);
                }
            }
            catch (JsonException)
            {
                // Invalid cross-instance messages are deliberately discarded.
            }
        });
        return new Subscription(queue);
    }

    private RedisChannel Channel() =>
        RedisChannel.Literal($"{options.InstancePrefix}:{options.PubSubChannel}");

    private static bool IsValidBusMessage(RealtimeBusMessage message) =>
        IsSafeBusIdentifier(message.MessageId) &&
        IsSafeBusIdentifier(message.TenantId) &&
        (message.UserId is null || IsSafeBusIdentifier(message.UserId)) &&
        IsSafeBusIdentifier(message.Topic) &&
        ProtocolValidator.IsValidCorrelationId(message.CorrelationId) &&
        message.Timestamp != default &&
        message.Payload.ValueKind is not JsonValueKind.Undefined and not JsonValueKind.Null &&
        !string.IsNullOrWhiteSpace(message.SourceInstance) &&
        message.SourceInstance.Length <= 256;

    private static bool IsSafeBusIdentifier(string value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= 128 &&
        value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');

    private sealed class Subscription(ChannelMessageQueue queue) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync() => await queue.UnsubscribeAsync();
    }
}

public sealed record DurableDelivery(string EntryId, DurableStreamMessage Message);

public interface IDurableRealtimeStore
{
    ValueTask<string> AppendAsync(DurableStreamMessage message, CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<DurableDelivery>> ReadAsync(
        string eventClass,
        string group,
        string consumer,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<DurableDelivery>> RecoverPendingAsync(
        string eventClass,
        string group,
        string consumer,
        CancellationToken cancellationToken);

    ValueTask<bool> TryMarkCompletedAsync(
        string eventClass,
        string messageId,
        CancellationToken cancellationToken);

    ValueTask AcknowledgeAsync(
        string eventClass,
        string group,
        string entryId,
        CancellationToken cancellationToken);
}

public sealed class RedisDurableRealtimeStore(
    RedisConnectionProvider connectionProvider,
    RedisOptions options) : IDurableRealtimeStore
{
    public async ValueTask<string> AppendAsync(
        DurableStreamMessage message,
        CancellationToken cancellationToken)
    {
        EnsureEnabled();
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var json = JsonSerializer.Serialize(
            message,
            RealtimeJsonSerializerContext.Default.DurableStreamMessage);
        var id = await connection.GetDatabase().StreamAddAsync(
            StreamKey(message.EventClass),
            "data",
            json,
            maxLength: options.StreamMaxLength,
            useApproximateMaxLength: true);
        return id.ToString();
    }

    public async ValueTask<IReadOnlyList<DurableDelivery>> ReadAsync(
        string eventClass,
        string group,
        string consumer,
        CancellationToken cancellationToken)
    {
        EnsureEnabled();
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var database = connection.GetDatabase();
        var key = StreamKey(eventClass);
        try
        {
            await database.StreamCreateConsumerGroupAsync(key, group, StreamPosition.Beginning, createStream: true);
        }
        catch (RedisServerException exception) when (exception.Message.Contains("BUSYGROUP", StringComparison.Ordinal))
        {
            // Consumer-group creation is idempotent; an existing group is ready for reads.
        }

        var entries = await database.StreamReadGroupAsync(
            key,
            group,
            consumer,
            StreamPosition.NewMessages,
            options.StreamReadCount);
        return await ParseEntriesAsync(database, key, group, eventClass, entries);
    }

    public async ValueTask<IReadOnlyList<DurableDelivery>> RecoverPendingAsync(
        string eventClass,
        string group,
        string consumer,
        CancellationToken cancellationToken)
    {
        EnsureEnabled();
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        var database = connection.GetDatabase();
        var key = StreamKey(eventClass);
        await EnsureConsumerGroupAsync(database, key, group);
        var deliveries = new List<DurableDelivery>();
        var cursor = (RedisValue)"0-0";
        var visited = new HashSet<string>(StringComparer.Ordinal);
        do
        {
            cancellationToken.ThrowIfCancellationRequested();
            var claimed = await database.StreamAutoClaimAsync(
                key,
                group,
                consumer,
                options.StreamClaimIdleMilliseconds,
                cursor,
                options.StreamReadCount);
            deliveries.AddRange(await ParseEntriesAsync(
                database,
                key,
                group,
                eventClass,
                claimed.ClaimedEntries));
            cursor = claimed.NextStartId;
        }
        while (cursor != "0-0" && visited.Add(cursor.ToString()));

        return deliveries;
    }

    public async ValueTask<bool> TryMarkCompletedAsync(
        string eventClass,
        string messageId,
        CancellationToken cancellationToken)
    {
        EnsureEnabled();
        if (!IsSafeIdentifier(messageId))
        {
            throw new ArgumentException("Message id contains unsupported characters.", nameof(messageId));
        }

        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        return await connection.GetDatabase().StringSetAsync(
            IdempotencyKey(eventClass, messageId),
            "processed",
            TimeSpan.FromSeconds(options.StreamIdempotencyTtlSeconds),
            When.NotExists);
    }

    private async ValueTask<IReadOnlyList<DurableDelivery>> ParseEntriesAsync(
        IDatabase database,
        RedisKey key,
        RedisValue group,
        string eventClass,
        StreamEntry[] entries)
    {
        var deliveries = new List<DurableDelivery>(entries.Length);
        foreach (var entry in entries)
        {
            var value = entry.Values.FirstOrDefault(item => item.Name == "data").Value;
            if (value.IsNullOrEmpty)
            {
                await QuarantineAsync(database, key, group, entry, value, "missing_data");
                continue;
            }

            try
            {
                var message = JsonSerializer.Deserialize(
                    value.ToString(),
                    RealtimeJsonSerializerContext.Default.DurableStreamMessage);
                if (message is not null && IsValidDurableMessage(eventClass, message))
                {
                    deliveries.Add(new DurableDelivery(entry.Id.ToString(), message));
                    continue;
                }

                await QuarantineAsync(database, key, group, entry, value, "invalid_contract");
            }
            catch (JsonException)
            {
                await QuarantineAsync(database, key, group, entry, value, "invalid_json");
            }
        }

        return deliveries;
    }

    private async ValueTask QuarantineAsync(
        IDatabase database,
        RedisKey key,
        RedisValue group,
        StreamEntry entry,
        RedisValue value,
        RedisValue reason)
    {
        await database.StreamAddAsync(
            PoisonKey(key),
            [
                new NameValueEntry("entryId", entry.Id),
                new NameValueEntry("reason", reason),
                new NameValueEntry("data", value.IsNull ? string.Empty : value),
            ],
            maxLength: options.StreamPoisonMaxLength,
            useApproximateMaxLength: true);
        await database.StreamAcknowledgeAsync(key, group, entry.Id);
    }

    public async ValueTask AcknowledgeAsync(
        string eventClass,
        string group,
        string entryId,
        CancellationToken cancellationToken)
    {
        EnsureEnabled();
        cancellationToken.ThrowIfCancellationRequested();
        var connection = await connectionProvider.GetConnectionAsync(cancellationToken);
        await connection.GetDatabase().StreamAcknowledgeAsync(StreamKey(eventClass), group, entryId);
    }

    private RedisKey StreamKey(string eventClass)
    {
        if (string.IsNullOrWhiteSpace(eventClass) ||
            eventClass.Length > 64 ||
            eventClass.Any(character => !char.IsLetterOrDigit(character) && character is not '-' and not '_'))
        {
            throw new ArgumentException("Event class contains unsupported characters.", nameof(eventClass));
        }

        return $"{options.InstancePrefix}:{options.StreamKeyPrefix}:{eventClass}";
    }

    private RedisKey IdempotencyKey(string eventClass, string messageId) =>
        $"{StreamKey(eventClass)}:processed:{messageId}";

    private static RedisKey PoisonKey(RedisKey streamKey) => $"{streamKey}:poison";

    private static bool IsSafeIdentifier(string? value) =>
        value is not null &&
        value.Length is >= 1 and <= 128 &&
        value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');

    private static bool IsValidDurableMessage(string expectedEventClass, DurableStreamMessage message) =>
        string.Equals(message.EventClass, expectedEventClass, StringComparison.Ordinal) &&
        IsSafeIdentifier(message.MessageId) &&
        IsSafeIdentifier(message.TenantId) &&
        (message.UserId is null || IsSafeIdentifier(message.UserId)) &&
        IsSafeIdentifier(message.Topic) &&
        ProtocolValidator.IsValidCorrelationId(message.CorrelationId) &&
        message.Timestamp != default &&
        message.Payload.ValueKind is not JsonValueKind.Undefined and not JsonValueKind.Null &&
        !string.IsNullOrWhiteSpace(message.SourceInstance) &&
        message.SourceInstance.Length <= 256;

    private static async ValueTask EnsureConsumerGroupAsync(
        IDatabase database,
        RedisKey key,
        RedisValue group)
    {
        try
        {
            await database.StreamCreateConsumerGroupAsync(key, group, StreamPosition.Beginning, createStream: true);
        }
        catch (RedisServerException exception) when (exception.Message.Contains("BUSYGROUP", StringComparison.Ordinal))
        {
            // Consumer-group creation is idempotent; an existing group is ready for recovery.
        }
    }

    private void EnsureEnabled()
    {
        if (!options.StreamsEnabled)
        {
            throw new InvalidOperationException("Durable Redis Streams delivery is disabled.");
        }
    }
}
