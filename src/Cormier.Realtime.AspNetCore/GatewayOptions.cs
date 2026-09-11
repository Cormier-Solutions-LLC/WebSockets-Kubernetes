using Microsoft.Extensions.Options;

namespace Cormier.Realtime.Gateway;

public sealed class GatewayOptions
{
    public const string SectionName = "Gateway";

    public string ServiceName { get; set; } = "cormier-realtime-gateway";

    public int ShutdownDrainSeconds { get; set; } = 25;

    public bool DetailedHealthChecks { get; set; }

    public string Topology { get; set; } = "unspecified";
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

public sealed class DiagnosticsOptions
{
    public const string SectionName = "Diagnostics";

    public bool Enabled { get; set; }

    public bool ProductionEnabled { get; set; }

    public string BasePath { get; set; } = "/diagnostics/v1";

    public string AuthorizationPolicy { get; set; } = string.Empty;

    public string[] AllowedOrigins { get; set; } = [];

    public string[] AllowedNetworks { get; set; } = [];

    public string[] LogCategoryAllowlist { get; set; } = ["Cormier.Realtime"];

    public int MaximumDetailItems { get; set; } = 100;

    public int MaximumConcurrentRequests { get; set; } = 8;

    public int MaximumTailSessions { get; set; } = 4;

    public int TailBufferCapacity { get; set; } = 128;

    public int TailEventsPerSecond { get; set; } = 50;

    public int TailBytesPerSecond { get; set; } = 64 * 1024;

    public int MaximumTailDurationSeconds { get; set; } = 900;

    public int MinimumLogOverrideSeconds { get; set; } = 30;

    public int MaximumLogOverrideSeconds { get; set; } = 3600;

    public int AuditCapacity { get; set; } = 500;

    public int AuditRetentionDays { get; set; } = 30;

    public string CoordinationChannel { get; set; } = "diagnostics:log-level";
}

public sealed class MetricsOptions
{
    public const string SectionName = "Metrics";

    public bool Enabled { get; set; } = true;

    public string Path { get; set; } = "/metrics";

    public string? AuthorizationPolicy { get; set; }

    public string[] AllowedNetworks { get; set; } = [];

    public bool OtlpEnabled { get; set; }
}

public sealed class DiagnosticsEnvironmentValidator(IHostEnvironment environment) : IValidateOptions<DiagnosticsOptions>
{
    public ValidateOptionsResult Validate(string? name, DiagnosticsOptions options)
    {
        if (options.Enabled && environment.IsProduction() && !options.ProductionEnabled)
        {
            return ValidateOptionsResult.Fail(
                "Diagnostics:ProductionEnabled must be explicitly true before diagnostics can run in Production.");
        }
        if (options.Enabled && environment.IsProduction() && options.AllowedNetworks.Length == 0)
        {
            return ValidateOptionsResult.Fail(
                "Diagnostics:AllowedNetworks must be explicitly configured when diagnostics run in Production.");
        }

        return ValidateOptionsResult.Success;
    }
}
