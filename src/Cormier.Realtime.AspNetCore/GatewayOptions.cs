namespace Cormier.Realtime.Gateway;

public sealed class GatewayOptions
{
    public const string SectionName = "Gateway";

    public string ServiceName { get; set; } = "cormier-realtime-gateway";

    public int ShutdownDrainSeconds { get; set; } = 25;

    public bool DetailedHealthChecks { get; set; }
}

public sealed class RealtimeOptions
{
    public const string SectionName = "Realtime";

    public string EndpointPath { get; set; } = "/realtime/ws";

    public string SessionCookieName { get; set; } = "cormier_session";

    public RealtimeSessionSource SessionSource { get; set; } = RealtimeSessionSource.Cookie;

    public string AspNetCoreSessionIdKey { get; set; } = "Cormier.Realtime.SessionId";

    public string[] AllowedOrigins { get; set; } = [];

    public int MaximumFrameBytes { get; set; } = 16 * 1024;

    public int MaximumMessageBytes { get; set; } = 64 * 1024;

    public int OutboundQueueCapacity { get; set; } = 128;

    public int MaximumSubscriptions { get; set; } = 64;

    public int MaximumTrackedCorrelations { get; set; } = 512;

    public int SlowConsumerStrikeLimit { get; set; } = 3;

    public int HeartbeatSeconds { get; set; } = 15;

    public int IdleTimeoutSeconds { get; set; } = 45;

    public int TicketLifetimeSeconds { get; set; } = 30;

    public string TicketEndpointPath { get; set; } = "/realtime/tickets";

    public string? AuthorizationPolicy { get; set; }

    public string[] DurableEventClasses { get; set; } = [];
}

public enum RealtimeSessionSource
{
    Cookie,
    AspNetCoreSession,
}

public sealed class ProxyOptions
{
    public const string SectionName = "Proxy";

    public string[] TrustedNetworks { get; set; } = [];
}
