using Propago.Realtime.Redis;
using StackExchange.Redis;

namespace Propago.Realtime.Gateway;

public sealed class RedisSubscriberService(
    IRealtimeMessageBus messageBus,
    RealtimeConnectionRegistry registry,
    RedisSubscriptionState subscriptionState,
    GatewayMetrics metrics,
    ILogger<RedisSubscriberService> logger) : BackgroundService
{
    private static readonly Action<ILogger, int, Exception?> LogRetry = LoggerMessage.Define<int>(
        LogLevel.Warning,
        new EventId(2001, "RedisSubscriptionRetry"),
        "Redis subscription unavailable; retrying in {DelaySeconds} seconds");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var retry = 1;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var subscription = await messageBus.SubscribeAsync(
                    message => registry.DeliverAsync(message, stoppingToken),
                    stoppingToken);
                subscriptionState.MarkActive();
                metrics.RecordRedisOperation("subscribe", true);
                retry = 1;
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
                }
                finally
                {
                    subscriptionState.MarkInactive();
                }
            }
            catch (RedisException exception)
            {
                metrics.RecordRedisOperation("subscribe", false);
                var delay = Math.Min(retry, 30);
                LogRetry(logger, delay, exception);
                await Task.Delay(TimeSpan.FromSeconds(delay), stoppingToken);
                retry = Math.Min(retry * 2, 30);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }
}
