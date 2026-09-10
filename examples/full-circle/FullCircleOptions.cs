namespace Cormier.Realtime.Example.FullCircle;

public sealed class FullCircleOptions
{
    public const string SectionName = "FullCircle";

    public string Topology { get; set; } = string.Empty;

    public string InstanceName { get; set; } = string.Empty;

    public int SessionLifetimeMinutes { get; set; } = 20;

    public string[] AllowedTenants { get; set; } = [];

    public string[] AllowedUsers { get; set; } = [];
}

public sealed record LoginRequest(string TenantId, string UserId);
