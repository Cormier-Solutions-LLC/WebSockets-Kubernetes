namespace Propago.Realtime.Gateway;

public sealed class GatewayOptions
{
    public const string SectionName = "Gateway";

    public string ServiceName { get; init; } = "propago-realtime-gateway";

    public int ShutdownDrainSeconds { get; init; } = 25;

    public bool DetailedHealthChecks { get; init; }
}
