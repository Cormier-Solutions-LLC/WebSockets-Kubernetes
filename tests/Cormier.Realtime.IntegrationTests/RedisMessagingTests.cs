using System.Text.Json;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Redis;
using StackExchange.Redis;

namespace Cormier.Realtime.IntegrationTests;

public sealed class RedisMessagingTests
{
    private static string Endpoint =>
        Environment.GetEnvironmentVariable("REDIS_TEST_ENDPOINT") ?? "host.docker.internal:16379";

    [Fact]
    public async Task SessionsAndSingleUseTicketsEnforceExpiryAudienceAndReuse()
    {
        var options = Options();
        await using var provider = new RedisConnectionProvider(options);
        var database = (await provider.GetConnectionAsync(CancellationToken.None)).GetDatabase();
        var sessions = new RedisSessionStore(provider, options);
        var tickets = new RedisConnectionTicketStore(provider, options);
        var validId = "valid-session-123456";
        var expiredId = "expired-session-123456";
        var revokedId = "revoked-session-123456";
        await StoreSessionAsync(database, options, validId, DateTimeOffset.UtcNow.AddMinutes(5));
        await StoreSessionAsync(database, options, expiredId, DateTimeOffset.UtcNow.AddMinutes(-1));
        await StoreSessionAsync(database, options, revokedId, DateTimeOffset.UtcNow.AddMinutes(5), revoked: true);

        var identity = await sessions.ValidateAsync(validId, CancellationToken.None);
        Assert.NotNull(identity);
        await Assert.ThrowsAsync<ArgumentException>(async () => await tickets.IssueAsync(
            identity with { SessionId = "short" },
            "gateway.example",
            TimeSpan.FromSeconds(5),
            CancellationToken.None));
        Assert.Null(await sessions.ValidateAsync(expiredId, CancellationToken.None));
        Assert.Null(await sessions.ValidateAsync(revokedId, CancellationToken.None));
        Assert.Null(await sessions.ValidateAsync("missing-session-123456", CancellationToken.None));

        var ticket = await tickets.IssueAsync(
            identity,
            "gateway.example",
            TimeSpan.FromSeconds(5),
            CancellationToken.None);
        Assert.Null(await tickets.ConsumeAsync(ticket, "wrong.example", CancellationToken.None));
        Assert.Null(await tickets.ConsumeAsync(ticket, "gateway.example", CancellationToken.None));

        var usableTicket = await tickets.IssueAsync(
            identity with { SessionId = validId },
            "gateway.example",
            TimeSpan.FromSeconds(5),
            CancellationToken.None);
        var consumed = await tickets.ConsumeAsync(usableTicket, "gateway.example", CancellationToken.None);
        Assert.NotNull(consumed);
        Assert.Equal(validId, consumed.SessionId);
        Assert.Null(await tickets.ConsumeAsync(usableTicket, "gateway.example", CancellationToken.None));
        Assert.Null(await tickets.ConsumeAsync(string.Empty, "gateway.example", CancellationToken.None));
        Assert.Null(await tickets.ConsumeAsync("not/a/valid/ticket/value/1234567890", "gateway.example", CancellationToken.None));

        var expiredTicket = await tickets.IssueAsync(
            identity,
            "gateway.example",
            TimeSpan.FromMilliseconds(50),
            CancellationToken.None);
        await Task.Delay(150);
        Assert.Null(await tickets.ConsumeAsync(expiredTicket, "gateway.example", CancellationToken.None));

        var shortIdentity = identity with { ExpiresAt = DateTimeOffset.UtcNow.AddMilliseconds(150) };
        var cappedTicket = await tickets.IssueAsync(
            shortIdentity,
            "gateway.example",
            TimeSpan.FromSeconds(5),
            CancellationToken.None);
        await Task.Delay(250);
        Assert.Null(await tickets.ConsumeAsync(cappedTicket, "gateway.example", CancellationToken.None));
    }

    [Fact]
    public async Task TwoInstancesExchangeNamespacedPubSubMessages()
    {
        var options = Options();
        await using var firstProvider = new RedisConnectionProvider(options);
        await using var secondProvider = new RedisConnectionProvider(options);
        var publisher = new RedisRealtimeMessageBus(firstProvider, options);
        var subscriber = new RedisRealtimeMessageBus(secondProvider, options);
        var received = new TaskCompletionSource<RealtimeBusMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var subscription = await subscriber.SubscribeAsync(
            message =>
            {
                received.TrySetResult(message);
                return ValueTask.CompletedTask;
            },
            CancellationToken.None);
        var expected = BusMessage();

        await publisher.PublishAsync(expected, CancellationToken.None);
        var actual = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(expected.MessageId, actual.MessageId);
        Assert.Equal(expected.TenantId, actual.TenantId);
        Assert.Equal(expected.Payload.GetProperty("value").GetInt32(), actual.Payload.GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task SharedPublisherMultiplexerPreservesRemoteSubscription()
    {
        var options = Options();
        await using var publisherProvider = new RedisConnectionProvider(options);
        await using var subscriberProvider = new RedisConnectionProvider(options);
        var publisher = new RedisRealtimeMessageBus(publisherProvider, options);
        var subscriber = new RedisRealtimeMessageBus(subscriberProvider, options);
        var received = new TaskCompletionSource<RealtimeBusMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var subscription = await subscriber.SubscribeAsync(
            message =>
            {
                received.TrySetResult(message);
                return ValueTask.CompletedTask;
            },
            CancellationToken.None);

        var shared = await publisherProvider.GetConnectionAsync(CancellationToken.None);
        Assert.Same(shared, await publisherProvider.GetConnectionAsync(CancellationToken.None));
        var expected = BusMessage();
        await publisher.PublishAsync(expected, CancellationToken.None);

        Assert.Equal(expected.MessageId, (await received.Task.WaitAsync(TimeSpan.FromSeconds(5))).MessageId);
    }

    [Fact]
    public async Task PubSubDiscardsStructurallyInvalidEnvelope()
    {
        var options = Options();
        await using var provider = new RedisConnectionProvider(options);
        var bus = new RedisRealtimeMessageBus(provider, options);
        var invoked = false;
        await using var subscription = await bus.SubscribeAsync(
            _ =>
            {
                invoked = true;
                return ValueTask.CompletedTask;
            },
            CancellationToken.None);
        var connection = await provider.GetConnectionAsync(CancellationToken.None);

        await connection.GetSubscriber().PublishAsync(
            RedisChannel.Literal($"{options.InstancePrefix}:{options.PubSubChannel}"),
            "{}");
        await Task.Delay(100);

        Assert.False(invoked);
    }

    [Fact]
    public async Task StreamsSupportAckRecoveryIdempotencyAndPoisonQuarantine()
    {
        var options = Options(streamsEnabled: true);
        await using var provider = new RedisConnectionProvider(options);
        var store = new RedisDurableRealtimeStore(provider, options);
        var message = DurableMessage();
        var entryId = await store.AppendAsync(message, CancellationToken.None);

        var initial = await store.ReadAsync("audit", "gateways", "instance-a", CancellationToken.None);
        Assert.Contains(initial, delivery => delivery.EntryId == entryId && delivery.Message.MessageId == message.MessageId);
        await Task.Delay(options.StreamClaimIdleMilliseconds + 25);
        var recovered = await store.RecoverPendingAsync("audit", "gateways", "instance-b", CancellationToken.None);
        Assert.Contains(recovered, delivery => delivery.EntryId == entryId);
        Assert.True(await store.TryMarkCompletedAsync("audit", message.MessageId, CancellationToken.None));
        Assert.False(await store.TryMarkCompletedAsync("audit", message.MessageId, CancellationToken.None));
        await store.AcknowledgeAsync("audit", "gateways", entryId, CancellationToken.None);

        var database = (await provider.GetConnectionAsync(CancellationToken.None)).GetDatabase();
        var streamKey = $"{options.InstancePrefix}:{options.StreamKeyPrefix}:audit";
        await database.StreamAddAsync(streamKey, "data", "{not-json");
        await database.StreamAddAsync(streamKey, "data", "null");
        await database.StreamAddAsync(streamKey, "other", "missing");
        await database.StreamAddAsync(streamKey, "data", "{}");
        await database.StreamAddAsync(streamKey, "data", "{\"eventClass\":\"audit\"}");
        var poisonRead = await store.ReadAsync("audit", "gateways", "instance-b", CancellationToken.None);
        Assert.Empty(poisonRead);
        Assert.Equal(5, await database.StreamLengthAsync($"{streamKey}:poison"));

        for (var index = 0; index < 500; index++)
        {
            await store.AppendAsync(DurableMessage(), CancellationToken.None);
        }

        Assert.InRange(await database.StreamLengthAsync(streamKey), 1, options.StreamMaxLength * 2);
    }

    [Fact]
    public async Task PendingRecoveryAdvancesPastYoungPrefix()
    {
        var options = Options(streamsEnabled: true, streamClaimIdleMilliseconds: 1_000);
        await using var provider = new RedisConnectionProvider(options);
        var store = new RedisDurableRealtimeStore(provider, options);
        var ids = new List<RedisValue>();
        for (var index = 0; index < 30; index++)
        {
            ids.Add(await store.AppendAsync(DurableMessage(), CancellationToken.None));
        }

        var database = (await provider.GetConnectionAsync(CancellationToken.None)).GetDatabase();
        var streamKey = $"{options.InstancePrefix}:{options.StreamKeyPrefix}:audit";
        await database.StreamCreateConsumerGroupAsync(streamKey, "recovery", StreamPosition.Beginning);
        var pending = await database.StreamReadGroupAsync(
            streamKey,
            "recovery",
            "original",
            StreamPosition.NewMessages,
            count: 30);
        Assert.Equal(30, pending.Length);
        await Task.Delay(options.StreamClaimIdleMilliseconds + 100);
        await database.StreamClaimAsync(
            streamKey,
            "recovery",
            "fresh",
            minIdleTimeInMs: 0,
            ids.Take(20).ToArray());

        var recovered = await store.RecoverPendingAsync(
            "audit",
            "recovery",
            "replacement",
            CancellationToken.None);

        Assert.All(ids.Skip(20), expected =>
            Assert.Contains(recovered, delivery => delivery.EntryId == expected.ToString()));
    }

    private static RedisOptions Options(
        bool streamsEnabled = false,
        int streamClaimIdleMilliseconds = 10) => new()
    {
        Endpoint = Endpoint,
        InstancePrefix = $"cormier:test:{Guid.NewGuid():N}",
        StreamsEnabled = streamsEnabled,
        StreamClaimIdleMilliseconds = streamClaimIdleMilliseconds,
        StreamReadCount = 10,
        StreamMaxLength = 100,
        StreamIdempotencyTtlSeconds = 60,
        StreamPoisonMaxLength = 10,
    };

    private static RealtimeBusMessage BusMessage() => new(
        Guid.NewGuid().ToString("N"),
        "tenant-1",
        "user-1",
        "orders",
        "correlation:tenant/orders/1",
        DateTimeOffset.UtcNow,
        JsonSerializer.SerializeToElement(new { value = 42 }),
        "instance-a");

    private static DurableStreamMessage DurableMessage()
    {
        var message = BusMessage();
        return new DurableStreamMessage(
            "audit",
            message.MessageId,
            message.TenantId,
            message.UserId,
            message.Topic,
            message.CorrelationId,
            message.Timestamp,
            message.Payload,
            message.SourceInstance);
    }

    private static async Task StoreSessionAsync(
        IDatabase database,
        RedisOptions options,
        string sessionId,
        DateTimeOffset expiresAt,
        bool revoked = false)
    {
        var record = new RedisSessionRecord("tenant-1", "user-1", ["orders"], expiresAt, revoked);
        var json = JsonSerializer.Serialize(record, RealtimeJsonSerializerContext.Default.RedisSessionRecord);
        await database.StringSetAsync($"{options.InstancePrefix}:{options.SessionKeyPrefix}:{sessionId}", json);
    }
}
