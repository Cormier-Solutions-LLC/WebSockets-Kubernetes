namespace Propago.Realtime.Redis;

public sealed class RedisOptions
{
    public const string SectionName = "Redis";

    public string Endpoint { get; init; } = "localhost:6379";

    public string InstancePrefix { get; init; } = "propago:realtime";

    public bool RequiredForReadiness { get; init; }

    public int ConnectRetryCount { get; init; } = 3;

    public int ConnectTimeoutMilliseconds { get; init; } = 5_000;

    public string SessionKeyPrefix { get; init; } = "sessions";

    public string TicketKeyPrefix { get; init; } = "tickets";

    public string PubSubChannel { get; init; } = "events";

    public bool StreamsEnabled { get; init; }

    public string StreamKeyPrefix { get; init; } = "streams";

    public int StreamMaxLength { get; init; } = 10_000;

    public int StreamReadCount { get; init; } = 100;

    public int StreamClaimIdleMilliseconds { get; init; } = 30_000;

    public int StreamIdempotencyTtlSeconds { get; init; } = 86_400;

    public int StreamPoisonMaxLength { get; init; } = 1_000;
}

public interface IRedisReadinessProbe
{
    ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken);
}

public sealed class DeferredRedisReadinessProbe : IRedisReadinessProbe
{
    public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(true);
    }
}
