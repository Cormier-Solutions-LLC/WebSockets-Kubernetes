namespace Cormier.Realtime.HttpFallback;

public sealed class HttpFallbackOptions
{
    public const string SectionName = "HttpFallback";

    public string BasePath { get; set; } = "/realtime/http";

    public int ConnectionTimeoutSeconds { get; set; } = 30;

    public int PollTimeoutSeconds { get; set; } = 10;
}
