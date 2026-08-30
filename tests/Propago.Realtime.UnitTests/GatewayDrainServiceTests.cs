using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Propago.Realtime.Gateway;
using Propago.Realtime.Redis;

namespace Propago.Realtime.UnitTests;

public sealed class GatewayDrainServiceTests
{
    [Fact]
    public async Task StoppingAsyncMarksDrainingAndHonorsCancellation()
    {
        var state = new GatewayState(
            new ReadyRedisProbe(),
            Options.Create(new RedisOptions()));
        var service = new GatewayDrainService(
            state,
            Options.Create(new GatewayOptions { ShutdownDrainSeconds = 300 }),
            NullLogger<GatewayDrainService>.Instance);
        using var cancellation = new CancellationTokenSource();

        var stopTask = service.StoppingAsync(cancellation.Token);
        await cancellation.CancelAsync();
        var completedTask = await Task.WhenAny(stopTask, Task.Delay(TimeSpan.FromSeconds(1)));

        Assert.Same(stopTask, completedTask);
        await stopTask;
        Assert.True(state.IsDraining);
    }

    private sealed class ReadyRedisProbe : IRedisReadinessProbe
    {
        public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(true);
    }
}
