using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;

namespace Cormier.Realtime.UnitTests;

public sealed class GatewayDrainServiceTests
{
    [Fact]
    public async Task StoppingAsyncMarksDrainingAndHonorsCancellation()
    {
        var state = new GatewayState(
            new ReadyRedisProbe(),
            Options.Create(new RedisOptions()),
            new RedisSubscriptionState());
        using var metrics = new GatewayMetrics();
        var service = new GatewayDrainService(
            state,
            new RealtimeConnectionRegistry(metrics),
            metrics,
            Options.Create(new GatewayOptions { ShutdownDrainSeconds = 300 }),
            NullLogger<GatewayDrainService>.Instance);
        using var cancellation = new CancellationTokenSource();

        var stopTask = service.StoppingAsync(cancellation.Token);
        await cancellation.CancelAsync();
        var completedTask = await Task.WhenAny(stopTask, Task.Delay(TimeSpan.FromSeconds(1)));

        Assert.Same(stopTask, completedTask);
        await stopTask;
        Assert.True(state.IsDraining);
        Assert.Contains("cormier_realtime_draining 1", metrics.RenderPrometheus(), StringComparison.Ordinal);
    }

    private sealed class ReadyRedisProbe : IRedisReadinessProbe
    {
        public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(true);
    }
}
