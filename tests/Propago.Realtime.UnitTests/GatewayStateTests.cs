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

    [Fact]
    public async Task ReadinessCannotReturnHealthyAfterDrainingBeginsDuringProbe()
    {
        var probe = new ControlledRedisReadinessProbe();
        var state = new GatewayState(
            probe,
            Options.Create(new RedisOptions { RequiredForReadiness = true }),
            ActiveSubscription());
        state.MarkStarted();

        var readiness = state.IsReadyAsync(CancellationToken.None).AsTask();
        await probe.Entered;
        state.BeginDrain();
        probe.Complete(ready: true);

        Assert.False(await readiness);
    }

    private static GatewayState CreateState(bool redisRequired, bool redisReady) =>
        new(
            new StubRedisReadinessProbe(redisReady),
            Options.Create(new RedisOptions { RequiredForReadiness = redisRequired }),
            ActiveSubscription());

    [Fact]
    public async Task ReadinessRequiresActiveRedisSubscription()
    {
        var subscription = new RedisSubscriptionState();
        var state = new GatewayState(
            new StubRedisReadinessProbe(true),
            Options.Create(new RedisOptions { RequiredForReadiness = true }),
            subscription);
        state.MarkStarted();

        Assert.False(await state.IsReadyAsync(CancellationToken.None));

        subscription.MarkActive();
        Assert.True(await state.IsReadyAsync(CancellationToken.None));

        subscription.MarkInactive();
        Assert.False(await state.IsReadyAsync(CancellationToken.None));
    }

    private static RedisSubscriptionState ActiveSubscription()
    {
        var state = new RedisSubscriptionState();
        state.MarkActive();
        return state;
    }

    private sealed class StubRedisReadinessProbe(bool ready) : IRedisReadinessProbe
    {
        public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(ready);
        }
    }

    private sealed class ControlledRedisReadinessProbe : IRedisReadinessProbe
    {
        private readonly TaskCompletionSource _entered = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _result = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public Task Entered => _entered.Task;

        public ValueTask<bool> IsReadyAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _entered.TrySetResult();
            return new ValueTask<bool>(_result.Task);
        }

        public void Complete(bool ready) => _result.TrySetResult(ready);
    }
}
