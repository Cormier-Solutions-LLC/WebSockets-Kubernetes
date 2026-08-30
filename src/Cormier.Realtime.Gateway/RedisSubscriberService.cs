using System.Diagnostics;
using Cormier.Realtime.Redis;
using StackExchange.Redis;

namespace Cormier.Realtime.Gateway;

public sealed class RedisSubscriberService(
    IRealtimeMessageBus messageBus,
    RedisConnectionProvider connectionProvider,
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
                var subscribeStarted = Stopwatch.GetTimestamp();
                var connection = await connectionProvider.GetConnectionAsync(stoppingToken);
                var subscriptionEstablished = 0;

                void MarkSubscription(bool active)
                {
                    if (active)
                    {
                        subscriptionState.MarkActive();
                    }
                    else
                    {
                        subscriptionState.MarkInactive();
                    }

                    metrics.RecordRedisSubscriptionState(active);
                }

                void OnConnectionFailed(object? _, ConnectionFailedEventArgs __)
                {
                    MarkSubscription(false);
                }

                void OnConnectionRestored(object? _, ConnectionFailedEventArgs __)
                {
                    if (Volatile.Read(ref subscriptionEstablished) == 1 && connection.IsConnected)
                    {
                        MarkSubscription(true);
                    }
                }

                connection.ConnectionFailed += OnConnectionFailed;
                connection.ConnectionRestored += OnConnectionRestored;
                try
                {
                    await using var subscription = await messageBus.SubscribeAsync(
                        message => registry.DeliverAsync(message, stoppingToken),
                        stoppingToken);
                    Volatile.Write(ref subscriptionEstablished, 1);
                    MarkSubscription(connection.IsConnected);
                    metrics.RecordRedisOperation("subscribe", true);
                    metrics.RecordRedisDuration("subscribe", Stopwatch.GetElapsedTime(subscribeStarted), true);
                    retry = 1;
                    await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
                }
                finally
                {
                    Volatile.Write(ref subscriptionEstablished, 0);
                    connection.ConnectionFailed -= OnConnectionFailed;
                    connection.ConnectionRestored -= OnConnectionRestored;
                    MarkSubscription(false);
                }
            }
            catch (RedisException exception)
            {
                metrics.RecordRedisOperation("subscribe", false);
                metrics.RecordRedisSubscriptionState(false);
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
