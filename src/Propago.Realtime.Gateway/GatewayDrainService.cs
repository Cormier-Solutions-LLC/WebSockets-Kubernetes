using Microsoft.Extensions.Options;

namespace Propago.Realtime.Gateway;

public sealed class GatewayDrainService(
    GatewayState state,
    RealtimeConnectionRegistry registry,
    IOptions<GatewayOptions> options,
    ILogger<GatewayDrainService> logger) : IHostedLifecycleService
{
    private static readonly Action<ILogger, string, Exception?> LogDrainComplete = LoggerMessage.Define<string>(
        LogLevel.Information,
        new EventId(1002, "GatewayDrainComplete"),
        "Gateway {ServiceName} completed its shutdown drain interval");

    private static readonly Action<ILogger, string, Exception?> LogDrainCancelled = LoggerMessage.Define<string>(
        LogLevel.Warning,
        new EventId(1003, "GatewayDrainCancelled"),
        "Gateway {ServiceName} shutdown drain interval was cancelled");

    public Task StartingAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StoppingAsync(CancellationToken cancellationToken)
    {
        state.BeginDrain();
        await registry.NotifyServiceRestartAsync();

        try
        {
            await Task.Delay(
                TimeSpan.FromSeconds(options.Value.ShutdownDrainSeconds),
                cancellationToken);
            await registry.CloseAllAsync(cancellationToken);
            LogDrainComplete(logger, options.Value.ServiceName, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await registry.CloseAllAsync(CancellationToken.None);
            LogDrainCancelled(logger, options.Value.ServiceName, null);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
