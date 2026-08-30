namespace Propago.Realtime.Redis;

public sealed class RedisOptions
{
    public const string SectionName = "Redis";

    public string Endpoint { get; init; } = "localhost:6379";

    public string InstancePrefix { get; init; } = "propago:realtime";

    public bool RequiredForReadiness { get; init; }
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
