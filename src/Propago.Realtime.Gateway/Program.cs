using System.Reflection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Options;
using Propago.Realtime.Contracts;
using Propago.Realtime.Gateway;
using Propago.Realtime.Redis;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
    options.UseUtcTimestamp = true;
});

builder.Services
    .AddOptions<GatewayOptions>()
    .Bind(builder.Configuration.GetSection(GatewayOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.ServiceName) && options.ServiceName.Length <= 128, "Gateway:ServiceName is required and must not exceed 128 characters.")
    .Validate(options => options.ShutdownDrainSeconds is >= 1 and <= 300, "Gateway:ShutdownDrainSeconds must be between 1 and 300.")
    .ValidateOnStart();

builder.Services
    .AddOptions<RedisOptions>()
    .Bind(builder.Configuration.GetSection(RedisOptions.SectionName))
    .Validate(options => !string.IsNullOrWhiteSpace(options.Endpoint), "Redis:Endpoint is required.")
    .Validate(options => string.IsNullOrWhiteSpace(options.User) == string.IsNullOrWhiteSpace(options.Password), "Redis:User and Redis:Password must be supplied together.")
    .Validate(options => string.IsNullOrWhiteSpace(options.SentinelServiceName) || !options.Ssl, "Redis Sentinel discovery and direct TLS cannot be enabled together.")
    .Validate(options => string.IsNullOrWhiteSpace(options.SentinelServiceName) || !string.IsNullOrWhiteSpace(options.SentinelPassword), "Redis:SentinelPassword is required when Sentinel discovery is enabled.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.InstancePrefix), "Redis:InstancePrefix is required.")
    .Validate(options => options.ConnectRetryCount is >= 1 and <= 20, "Redis:ConnectRetryCount must be between 1 and 20.")
    .Validate(options => options.StreamMaxLength is >= 100 and <= 1_000_000, "Redis:StreamMaxLength must be between 100 and 1000000.")
    .Validate(options => options.StreamReadCount is >= 1 and <= 1_000, "Redis:StreamReadCount must be between 1 and 1000.")
    .Validate(options => options.StreamClaimIdleMilliseconds is >= 1 and <= 3_600_000, "Redis:StreamClaimIdleMilliseconds must be between 1 and 3600000.")
    .Validate(options => options.StreamIdempotencyTtlSeconds is >= 60 and <= 2_592_000, "Redis:StreamIdempotencyTtlSeconds must be between 60 and 2592000.")
    .Validate(options => options.StreamPoisonMaxLength is >= 10 and <= 100_000, "Redis:StreamPoisonMaxLength must be between 10 and 100000.")
    .ValidateOnStart();

builder.Services
    .AddOptions<ProxyOptions>()
    .Bind(builder.Configuration.GetSection(ProxyOptions.SectionName))
    .Validate(options => options.TrustedNetworks.Length > 0 && options.TrustedNetworks.All(network => System.Net.IPNetwork.TryParse(network, out _)), "Proxy:TrustedNetworks must contain valid CIDR ranges.")
    .ValidateOnStart();

builder.Services
    .AddOptions<RealtimeOptions>()
    .Bind(builder.Configuration.GetSection(RealtimeOptions.SectionName))
    .Validate(options => options.EndpointPath.StartsWith('/'), "Realtime:EndpointPath must start with '/'.")
    .Validate(options => !string.IsNullOrWhiteSpace(options.SessionCookieName), "Realtime:SessionCookieName is required.")
    .Validate(options => options.AllowedOrigins.Length > 0 && options.AllowedOrigins.All(origin => Uri.TryCreate(origin, UriKind.Absolute, out _)), "Realtime:AllowedOrigins must contain absolute origins.")
    .Validate(options => options.MaximumFrameBytes is >= 1024 and <= 1_048_576, "Realtime:MaximumFrameBytes must be between 1024 and 1048576.")
    .Validate(options => options.MaximumMessageBytes >= options.MaximumFrameBytes, "Realtime:MaximumMessageBytes must be at least MaximumFrameBytes.")
    .Validate(options => options.OutboundQueueCapacity is >= 1 and <= 10_000, "Realtime:OutboundQueueCapacity must be between 1 and 10000.")
    .Validate(options => options.MaximumSubscriptions is >= 1 and <= 10_000, "Realtime:MaximumSubscriptions must be between 1 and 10000.")
    .Validate(options => options.MaximumTrackedCorrelations is >= 1 and <= 100_000, "Realtime:MaximumTrackedCorrelations must be between 1 and 100000.")
    .Validate(options => options.SlowConsumerStrikeLimit is >= 1 and <= 1_000, "Realtime:SlowConsumerStrikeLimit must be between 1 and 1000.")
    .Validate(options => options.HeartbeatSeconds is >= 5 and <= 300, "Realtime:HeartbeatSeconds must be between 5 and 300.")
    .Validate(options => options.IdleTimeoutSeconds > options.HeartbeatSeconds, "Realtime:IdleTimeoutSeconds must exceed HeartbeatSeconds.")
    .Validate(options => options.TicketLifetimeSeconds is >= 1 and <= 300, "Realtime:TicketLifetimeSeconds must be between 1 and 300.")
    .ValidateOnStart();
builder.Services.AddSingleton<IValidateOptions<RealtimeOptions>, RealtimeOptionsValidator>();
builder.Services
    .AddOptions<ForwardedHeadersOptions>()
    .Configure<IOptions<ProxyOptions>>((headers, proxy) =>
    {
        headers.ForwardedHeaders =
            ForwardedHeaders.XForwardedFor |
            ForwardedHeaders.XForwardedProto |
            ForwardedHeaders.XForwardedHost;
        headers.ForwardLimit = 1;
        headers.KnownIPNetworks.Clear();
        foreach (var network in proxy.Value.TrustedNetworks)
        {
            headers.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
        }
    });

var configuredDrainSeconds = builder.Configuration.GetValue<int?>(
    $"{GatewayOptions.SectionName}:ShutdownDrainSeconds") ?? 25;
builder.Services.Configure<HostOptions>(options =>
{
    var drainSeconds = configuredDrainSeconds is >= 1 and <= 300
        ? configuredDrainSeconds
        : 25;
    options.ShutdownTimeout = TimeSpan.FromSeconds(drainSeconds + 5);
});

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.TypeInfoResolverChain.Insert(0, RealtimeJsonSerializerContext.Default);
});
builder.Services.AddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<GatewayOptions>>().Value);
builder.Services.AddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<RedisOptions>>().Value);
builder.Services.AddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<RealtimeOptions>>().Value);
builder.Services.AddSingleton<RedisConnectionProvider>();
builder.Services.AddSingleton<IRedisReadinessProbe>(serviceProvider => serviceProvider.GetRequiredService<RedisConnectionProvider>());
builder.Services.AddSingleton<IRealtimeSessionStore, RedisSessionStore>();
builder.Services.AddSingleton<IConnectionTicketStore, RedisConnectionTicketStore>();
builder.Services.AddSingleton<IRealtimeMessageBus, RedisRealtimeMessageBus>();
builder.Services.AddSingleton<IDurableRealtimeStore, RedisDurableRealtimeStore>();
builder.Services.AddSingleton<GatewayState>();
builder.Services.AddSingleton<RedisSubscriptionState>();
builder.Services.AddSingleton<GatewayMetrics>();
builder.Services.AddSingleton<RealtimeConnectionRegistry>();
builder.Services.AddSingleton<RealtimeAuthenticator>();
builder.Services.AddSingleton<RealtimeDispatcher>();
builder.Services.AddSingleton<RealtimeWebSocketHandler>();
builder.Services.AddHostedService<RedisSubscriberService>();
builder.Services.AddHostedService<GatewayDrainService>();

builder.Configuration.AddCommandLine(args);
builder.Configuration.AddEnvironmentVariables();
var app = builder.Build();
var state = app.Services.GetRequiredService<GatewayState>();
var metrics = app.Services.GetRequiredService<GatewayMetrics>();
var gatewayOptions = app.Services.GetRequiredService<IOptions<GatewayOptions>>().Value;
var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("GatewayLifecycle");
var realtimeOptions = app.Services.GetRequiredService<IOptions<RealtimeOptions>>().Value;
var serviceVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
var logStarted = LoggerMessage.Define<string, string>(
    LogLevel.Information,
    new EventId(1000, "GatewayStarted"),
    "Gateway {ServiceName} version {Version} started");
var logDraining = LoggerMessage.Define<string>(
    LogLevel.Information,
    new EventId(1001, "GatewayDraining"),
    "Gateway {ServiceName} is draining for shutdown");
app.Lifetime.ApplicationStarted.Register(() =>
{
    state.MarkStarted();
    logStarted(logger, gatewayOptions.ServiceName, serviceVersion, null);
});
app.Lifetime.ApplicationStopping.Register(() =>
{
    state.BeginDrain();
    logDraining(logger, gatewayOptions.ServiceName, null);
});

app.UseForwardedHeaders();
app.UseWebSockets(new WebSocketOptions
{
    KeepAliveInterval = TimeSpan.FromSeconds(realtimeOptions.HeartbeatSeconds),
});

app.Map(realtimeOptions.EndpointPath, async (HttpContext context, RealtimeWebSocketHandler handler) =>
    await handler.HandleAsync(context));

app.MapPost("/realtime/tickets", async Task<Results<Ok<ConnectionTicketResponse>, UnauthorizedHttpResult>> (
    HttpContext context,
    RealtimeAuthenticator authenticator,
    IConnectionTicketStore ticketStore,
    CancellationToken cancellationToken) =>
{
    var authentication = await authenticator.AuthenticateSessionAsync(context.Request, cancellationToken);
    if (!authentication.Succeeded)
    {
        return TypedResults.Unauthorized();
    }

    var now = DateTimeOffset.UtcNow;
    var expiresAt = DateTimeOffset.Compare(
        authentication.Identity!.ExpiresAt,
        now.AddSeconds(realtimeOptions.TicketLifetimeSeconds)) < 0
        ? authentication.Identity.ExpiresAt
        : now.AddSeconds(realtimeOptions.TicketLifetimeSeconds);
    var lifetime = expiresAt - now;
    if (lifetime <= TimeSpan.Zero)
    {
        return TypedResults.Unauthorized();
    }

    var ticket = await ticketStore.IssueAsync(
        authentication.Identity!,
        context.Request.Host.Value ?? string.Empty,
        lifetime,
        cancellationToken);
    return TypedResults.Ok(new ConnectionTicketResponse(ticket, expiresAt));
});

app.MapGet("/health/startup", Results<Ok<HealthStatusResponse>, JsonHttpResult<HealthStatusResponse>> () =>
{
    metrics.RecordHealthRequest("startup");
    var started = state.IsStarted;
    var response = CreateHealthResponse(started ? "healthy" : "starting");
    return started
        ? TypedResults.Ok(response)
        : TypedResults.Json(
            response,
            RealtimeJsonSerializerContext.Default.HealthStatusResponse,
            statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/health/live", Ok<HealthStatusResponse> () =>
{
    metrics.RecordHealthRequest("live");
    return TypedResults.Ok(CreateHealthResponse("healthy"));
});

app.MapGet("/health/ready", async Task<Results<Ok<HealthStatusResponse>, JsonHttpResult<HealthStatusResponse>>> (CancellationToken cancellationToken) =>
{
    metrics.RecordHealthRequest("ready");
    var ready = await state.IsReadyAsync(cancellationToken);
    var response = CreateHealthResponse(ready ? "healthy" : "unavailable");
    return ready
        ? TypedResults.Ok(response)
        : TypedResults.Json(
            response,
            RealtimeJsonSerializerContext.Default.HealthStatusResponse,
            statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/metrics", ContentHttpResult () =>
{
    return TypedResults.Text(metrics.RenderPrometheus(), "text/plain; version=0.0.4; charset=utf-8");
});

app.Run();

HealthStatusResponse CreateHealthResponse(string status)
{
    IReadOnlyDictionary<string, string>? checks = null;
    if (gatewayOptions.DetailedHealthChecks)
    {
        checks = new Dictionary<string, string>
        {
            ["started"] = state.IsStarted ? "healthy" : "starting",
            ["draining"] = state.IsDraining ? "draining" : "accepting-traffic",
        };
    }

    return new HealthStatusResponse(status, serviceVersion, DateTimeOffset.UtcNow, checks);
}

public partial class Program;
