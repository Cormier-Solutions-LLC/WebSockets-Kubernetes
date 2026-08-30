namespace Propago.Realtime.Gateway;

public sealed class GatewayOptions
{
    public const string SectionName = "Gateway";

    public string ServiceName { get; set; } = "propago-realtime-gateway";

    public int ShutdownDrainSeconds { get; set; } = 25;

    public bool DetailedHealthChecks { get; set; }
}

public sealed class RealtimeOptions
{
    public const string SectionName = "Realtime";

    public string EndpointPath { get; set; } = "/realtime/ws";

    public string SessionCookieName { get; set; } = "propago_session";

    public string[] AllowedOrigins { get; set; } = ["https://propago.local"];

    public int MaximumFrameBytes { get; set; } = 16 * 1024;

    public int MaximumMessageBytes { get; set; } = 64 * 1024;

    public int OutboundQueueCapacity { get; set; } = 128;

    public int MaximumSubscriptions { get; set; } = 64;

    public int MaximumTrackedCorrelations { get; set; } = 512;

    public int SlowConsumerStrikeLimit { get; set; } = 3;

    public int HeartbeatSeconds { get; set; } = 15;

    public int IdleTimeoutSeconds { get; set; } = 45;

    public int TicketLifetimeSeconds { get; set; } = 30;

    public string[] DurableEventClasses { get; set; } = [];
}

public sealed class ProxyOptions
{
    public const string SectionName = "Proxy";

    public string[] TrustedNetworks { get; set; } =
        ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
}
