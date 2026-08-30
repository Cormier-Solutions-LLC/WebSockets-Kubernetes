using Microsoft.Extensions.Options;
using Propago.Realtime.Gateway;
using Propago.Realtime.Redis;

namespace Propago.Realtime.UnitTests;

public sealed class GatewayStateTests
{
    [Fact]
    public async Task ReadinessRequiresStartupAndRejectsDrainingState()
    {
        var state = CreateState(redisRequired: false, redisReady: false);

        Assert.False(await state.IsReadyAsync(CancellationToken.None));

        state.MarkStarted();
        Assert.True(await state.IsReadyAsync(CancellationToken.None));

        state.BeginDrain();
        Assert.False(await state.IsReadyAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData(false, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    public async Task RedisProbeIsConditional(
        bool redisRequired,
        bool redisReady,
        bool expectedReady)
    {
        var state = CreateState(redisRequired, redisReady);
        state.MarkStarted();

        Assert.Equal(
            expectedReady,
            await state.IsReadyAsync(CancellationToken.None));
    }

    private static GatewayState CreateState(bool redisRequired, bool redisReady) =>
        new(
            new StubRedisReadinessProbe(redisReady),
            Options.Create(new RedisOptions { RequiredForReadiness = redisRequired }));

    private sealed class StubRedisReadinessProbe(bool ready) : IRedisReadinessProbe
    {
        public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(ready);
        }
    }
}
