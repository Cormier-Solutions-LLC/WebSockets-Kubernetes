using System.Security.Cryptography;
using System.Text.Json;
using Cormier.Realtime.AspNetCore;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Example.FullCircle;
using Cormier.Realtime.Redis;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseStaticWebAssets();
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
app.UseRealtimeGateway();
app.UseSession();
if (diagnosticsEnabled)
{
    app.UseAuthentication();
    app.UseAuthorization();
}
app.UseStaticFiles();
app.MapStaticAssets();
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

app.MapGet("/api/diagnostics", async (IOptions<FullCircleOptions> settings, IRedisReadinessProbe redis,
    CancellationToken cancellationToken) => Results.Ok(new
    {
        topology = settings.Value.Topology,
        instance = settings.Value.InstanceName,
        redis = await redis.IsReadyAsync(cancellationToken) ? "ready" : "unavailable",
        timestamp = DateTimeOffset.UtcNow,
    }));
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));
app.MapFallbackToFile("index.html");
app.Run();

static bool IsSafeScope(string value) =>
    !string.IsNullOrWhiteSpace(value) && value.Length <= 128 &&
    value.All(character => char.IsLetterOrDigit(character) || character is '-' or '_' or '.');
