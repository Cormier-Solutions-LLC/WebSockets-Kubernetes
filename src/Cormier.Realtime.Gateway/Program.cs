using System.Reflection;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Options;
using Cormier.Realtime.AspNetCore;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;

var builder = WebApplication.CreateSlimBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options =>
{
    options.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
    options.UseUtcTimestamp = true;
});

builder.Services.AddRealtimeGateway(builder.Configuration);
var diagnosticsEnabled = builder.Configuration.GetValue<bool>("Diagnostics:Enabled");
var diagnosticsPolicy = builder.Configuration["Diagnostics:AuthorizationPolicy"];
var metricsPolicy = builder.Configuration["Metrics:AuthorizationPolicy"];
var protectedMetricsEnabled = builder.Configuration.GetValue<bool>("Metrics:Enabled") &&
    !string.IsNullOrWhiteSpace(metricsPolicy);
if (diagnosticsEnabled || protectedMetricsEnabled)
{
    var diagnosticsToken = builder.Configuration["Diagnostics:OperatorToken"];
    var primaryPolicy = diagnosticsEnabled ? diagnosticsPolicy : metricsPolicy;
    if (string.IsNullOrWhiteSpace(primaryPolicy) || string.IsNullOrWhiteSpace(diagnosticsToken))
    {
        throw new InvalidOperationException(
            "Protected standalone diagnostics or metrics require an authorization policy and a Secret-backed Diagnostics:OperatorToken.");
    }
    var additionalPolicies = diagnosticsEnabled && protectedMetricsEnabled &&
        !string.Equals(diagnosticsPolicy, metricsPolicy, StringComparison.Ordinal)
        ? new[] { metricsPolicy! }
        : [];
    builder.Services.AddRealtimeDiagnosticsBearer(primaryPolicy, diagnosticsToken, additionalPolicies);
}

builder.Configuration.AddCommandLine(args);
builder.Configuration.AddEnvironmentVariables();
var app = builder.Build();
var state = app.Services.GetRequiredService<GatewayState>();
var metrics = app.Services.GetRequiredService<GatewayMetrics>();
var gatewayOptions = app.Services.GetRequiredService<IOptions<GatewayOptions>>().Value;
var logger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("GatewayLifecycle");
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

app.UseRealtimeGateway();
if (diagnosticsEnabled || protectedMetricsEnabled)
{
    app.UseAuthentication();
    app.UseAuthorization();
}
app.MapRealtimeGateway();
app.MapRealtimeDiagnostics();

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
