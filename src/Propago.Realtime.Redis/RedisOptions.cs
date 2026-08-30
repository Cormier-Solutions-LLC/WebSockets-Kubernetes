namespace Propago.Realtime.Redis;

public sealed class RedisOptions
{
    public const string SectionName = "Redis";

    public string Endpoint { get; set; } = "localhost:6379";

    public string? User { get; set; }

    public string? Password { get; set; }

    public bool Ssl { get; set; }

    public string InstancePrefix { get; set; } = "propago:realtime";

    public bool RequiredForReadiness { get; set; }

    public int ConnectRetryCount { get; set; } = 3;

    public int ConnectTimeoutMilliseconds { get; set; } = 5_000;

    public string SessionKeyPrefix { get; set; } = "sessions";

    public string TicketKeyPrefix { get; set; } = "tickets";

    public string PubSubChannel { get; set; } = "events";

    public bool StreamsEnabled { get; set; }

    public string StreamKeyPrefix { get; set; } = "streams";

    public int StreamMaxLength { get; set; } = 10_000;

    public int StreamReadCount { get; set; } = 100;

    public int StreamClaimIdleMilliseconds { get; set; } = 30_000;

    public int StreamIdempotencyTtlSeconds { get; set; } = 86_400;

    public int StreamPoisonMaxLength { get; set; } = 1_000;
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
