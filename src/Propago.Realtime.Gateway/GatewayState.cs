using System.Diagnostics.Metrics;
using System.Reflection;
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

        return !redisOptions.Value.RequiredForReadiness ||
            await redisProbe.IsReadyAsync(cancellationToken);
    }
}

public sealed class GatewayMetrics : IDisposable
{
    private readonly Meter _meter = new(
        "Propago.Realtime.Gateway",
        typeof(GatewayMetrics).Assembly.GetName().Version?.ToString(3));
    private readonly Counter<long> _healthRequests;
    private long _healthRequestCount;

    public GatewayMetrics()
    {
        _healthRequests = _meter.CreateCounter<long>("gateway.health.requests");
    }

    public long HealthRequestCount => Interlocked.Read(ref _healthRequestCount);

    public void RecordHealthRequest(string endpoint)
    {
        Interlocked.Increment(ref _healthRequestCount);
        _healthRequests.Add(1, new KeyValuePair<string, object?>("endpoint", endpoint));
    }

    public void Dispose() => _meter.Dispose();
}
