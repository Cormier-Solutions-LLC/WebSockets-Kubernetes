using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cormier.Realtime.AspNetCore;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Example.FullCircle;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
StaticFileOptions? developmentSharedAssets = null;
if (builder.Environment.IsDevelopment())
{
    var sharedWebRoot = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "shared-web", "wwwroot"));
    if (!Directory.Exists(sharedWebRoot))
    {
        throw new DirectoryNotFoundException($"The shared development web root was not found: {sharedWebRoot}");
    }
    developmentSharedAssets = new StaticFileOptions
    {
        FileProvider = new PhysicalFileProvider(sharedWebRoot),
    };
}
string? generatedOperatorTokenPath = null;
if (builder.Environment.IsDevelopment() && string.IsNullOrWhiteSpace(builder.Configuration["Diagnostics:OperatorToken"]))
{
    var configuredTokenPath = builder.Configuration["FullCircleDevelopment:OperatorTokenFile"];
    if (string.IsNullOrWhiteSpace(configuredTokenPath))
    {
        throw new InvalidOperationException("FullCircleDevelopment:OperatorTokenFile is required in Development.");
    }
    generatedOperatorTokenPath = Path.GetFullPath(configuredTokenPath, builder.Environment.ContentRootPath);
    builder.Configuration["Diagnostics:OperatorToken"] = ReadOrCreateDevelopmentOperatorToken(generatedOperatorTokenPath);
}
builder.Services.AddOptions<FullCircleOptions>()
    .Bind(builder.Configuration.GetSection(FullCircleOptions.SectionName))
    .Validate(options => options.Topology is "ha" or "non-ha", "FullCircle:Topology must be explicitly set to 'ha' or 'non-ha'.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.InstanceName), "FullCircle:InstanceName is required.")
    .Validate(options => options.SessionLifetimeMinutes is >= 1 and <= 120, "FullCircle:SessionLifetimeMinutes must be between 1 and 120.")
    .Validate(options => options.AllowedTenants is { Length: > 0 } && options.AllowedTenants.All(IsSafeScope), "FullCircle:AllowedTenants must contain safe fixture identifiers.")
    .Validate(options => options.AllowedUsers is { Length: > 0 } && options.AllowedUsers.All(IsSafeScope), "FullCircle:AllowedUsers must contain safe fixture identifiers.")
    .ValidateOnStart();
builder.Services.AddRealtimeGateway(builder.Configuration);
var diagnosticsEnabled = builder.Configuration.GetValue<bool>("Diagnostics:Enabled");
if (diagnosticsEnabled)
{
    var diagnosticsPolicy = builder.Configuration["Diagnostics:AuthorizationPolicy"];
    var diagnosticsToken = builder.Configuration["Diagnostics:OperatorToken"];
    if (string.IsNullOrWhiteSpace(diagnosticsPolicy) || string.IsNullOrWhiteSpace(diagnosticsToken))
    {
        throw new InvalidOperationException(
            "Enabled full-circle diagnostics require a policy and runtime-provided operator token.");
    }
    builder.Services.AddRealtimeDiagnosticsBearer(diagnosticsPolicy, diagnosticsToken);
}
builder.Services.AddSingleton<IDistributedCache, RedisDistributedCache>();
var sessionLifetimeMinutes = builder.Configuration.GetValue<int?>("FullCircle:SessionLifetimeMinutes") ?? 20;
builder.Services.AddSession(options =>
{
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.IdleTimeout = TimeSpan.FromMinutes(sessionLifetimeMinutes);
});

var app = builder.Build();
if (generatedOperatorTokenPath is not null)
{
    FullCircleLog.DevelopmentOperatorTokenFile(app.Logger, generatedOperatorTokenPath);
}
app.UseRealtimeGateway();
app.UseSession();
if (diagnosticsEnabled)
{
    app.UseAuthentication();
    app.UseAuthorization();
}
app.UseStaticFiles();
if (developmentSharedAssets is not null)
{
    app.UseStaticFiles(developmentSharedAssets);
}
if (developmentSharedAssets is null)
{
    app.MapStaticAssets();
}
app.MapRealtimeGateway();
app.MapRealtimeDiagnostics();

app.MapPost("/api/login", async (LoginRequest request, HttpContext context, IOptions<FullCircleOptions> settings,
    RedisConnectionProvider connections, RedisOptions redis, CancellationToken cancellationToken) =>
{
    if (!settings.Value.AllowedTenants.Contains(request.TenantId, StringComparer.Ordinal) ||
        !settings.Value.AllowedUsers.Contains(request.UserId, StringComparer.Ordinal))
    {
        return Results.BadRequest(new { code = "invalid_identity", message = "Select a configured test tenant and user." });
    }

    var sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    var expiresAt = DateTimeOffset.UtcNow.AddMinutes(settings.Value.SessionLifetimeMinutes);
    var record = new RedisSessionRecord(request.TenantId, request.UserId, ["orders", "notifications"], expiresAt);
    var json = JsonSerializer.Serialize(record, RealtimeJsonSerializerContext.Default.RedisSessionRecord);
    var database = (await connections.GetConnectionAsync(cancellationToken)).GetDatabase();
    await database.StringSetAsync($"{redis.InstancePrefix}:{redis.SessionKeyPrefix}:{sessionId}", json, expiresAt - DateTimeOffset.UtcNow);
    context.Session.SetString("Cormier.Realtime.SessionId", sessionId);
    await context.Session.CommitAsync(cancellationToken);
    return Results.Ok(new { request.TenantId, request.UserId, expiresAt });
});

app.MapPost("/api/logout", async (HttpContext context, RedisConnectionProvider connections, RedisOptions redis,
    CancellationToken cancellationToken) =>
{
    var sessionId = context.Session.GetString("Cormier.Realtime.SessionId");
    if (!string.IsNullOrWhiteSpace(sessionId))
    {
        var database = (await connections.GetConnectionAsync(cancellationToken)).GetDatabase();
        await database.KeyDeleteAsync($"{redis.InstancePrefix}:{redis.SessionKeyPrefix}:{sessionId}");
    }
    context.Session.Clear();
    await context.Session.CommitAsync(cancellationToken);
    return Results.NoContent();
});

app.MapGet("/api/session", async (HttpContext context, IRealtimeSessionStore sessions, CancellationToken cancellationToken) =>
{
    var sessionId = context.Session.GetString("Cormier.Realtime.SessionId");
    var identity = string.IsNullOrWhiteSpace(sessionId) ? null : await sessions.ValidateAsync(sessionId, cancellationToken);
    return identity is null
        ? Results.Json(new { authenticated = false }, statusCode: StatusCodes.Status401Unauthorized)
        : Results.Ok(new { authenticated = true, identity.TenantId, identity.UserId, identity.AllowedTopics, identity.ExpiresAt });
});

app.MapGet("/api/diagnostics", async (IOptions<FullCircleOptions> settings, IOptions<RealtimeOptions> realtime,
    IRedisReadinessProbe redis,
    CancellationToken cancellationToken) => Results.Ok(new
    {
        stack = "ASP.NET Core",
        topology = settings.Value.Topology,
        instance = settings.Value.InstanceName,
        redis = await redis.IsReadyAsync(cancellationToken) ? "ready" : "unavailable",
        heartbeatIntervalMilliseconds = checked(realtime.Value.HeartbeatSeconds * 1000),
        links = new[]
        {
            new { href = "/esm.html", label = "Run the ESM variant" },
            new { href = "/operator.html", label = "Open the operator diagnostics workflow" }
        },
        timestamp = DateTimeOffset.UtcNow,
    }));
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));
if (developmentSharedAssets is null)
{
    app.MapFallbackToFile("index.html");
}
else
{
    app.MapFallbackToFile("index.html", developmentSharedAssets);
}
app.Run();

static bool IsSafeScope(string value) =>
    !string.IsNullOrWhiteSpace(value) && value.Length <= 128 &&
    value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');

static string ReadOrCreateDevelopmentOperatorToken(string tokenPath)
{
    var directory = Path.GetDirectoryName(tokenPath)
        ?? throw new InvalidOperationException("The development operator token path must include a directory.");
    Directory.CreateDirectory(directory);

    if (!File.Exists(tokenPath))
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        try
        {
            using var stream = new FileStream(
                tokenPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.Read,
                4096,
                FileOptions.WriteThrough);
            stream.Write(Encoding.UTF8.GetBytes($"{token}{Environment.NewLine}"));
        }
        catch (IOException) when (File.Exists(tokenPath))
        {
            // Another local process created the file first; its value is authoritative.
        }
    }

    if (!OperatingSystem.IsWindows())
    {
        File.SetUnixFileMode(tokenPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    var persistedToken = File.ReadAllText(tokenPath).Trim();
    if (persistedToken.Length != 64 || !persistedToken.All(Uri.IsHexDigit))
    {
        throw new InvalidOperationException(
            "The development diagnostics operator token file must contain exactly 64 hexadecimal characters.");
    }
    return persistedToken;
}

internal static partial class FullCircleLog
{
    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "The development diagnostics operator token is stored in {OperatorTokenFile}. The token value is not logged.")]
    public static partial void DevelopmentOperatorTokenFile(ILogger logger, string operatorTokenFile);
}
