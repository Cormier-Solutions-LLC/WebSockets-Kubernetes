namespace Propago.Realtime.Gateway;

public sealed class GatewayOptions
{
    public const string SectionName = "Gateway";

    public string ServiceName { get; init; } = "propago-realtime-gateway";

    public int ShutdownDrainSeconds { get; init; } = 25;

    public bool DetailedHealthChecks { get; init; }
}

public sealed class RealtimeOptions
{
    public const string SectionName = "Realtime";

    public string EndpointPath { get; init; } = "/realtime/ws";

    public string SessionCookieName { get; init; } = "propago_session";

    public string[] AllowedOrigins { get; init; } = ["https://propago.local"];

    public int MaximumFrameBytes { get; init; } = 16 * 1024;

    public int MaximumMessageBytes { get; init; } = 64 * 1024;

    public int OutboundQueueCapacity { get; init; } = 128;

    public int MaximumSubscriptions { get; init; } = 64;

    public int MaximumTrackedCorrelations { get; init; } = 512;

    public int SlowConsumerStrikeLimit { get; init; } = 3;

    public int HeartbeatSeconds { get; init; } = 15;

    public int IdleTimeoutSeconds { get; init; } = 45;

    public int TicketLifetimeSeconds { get; init; } = 30;

    public string[] DurableEventClasses { get; init; } = [];
}
