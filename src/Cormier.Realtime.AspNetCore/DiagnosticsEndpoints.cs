using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;
using Cormier.Realtime.Gateway;

namespace Cormier.Realtime.AspNetCore;

public sealed class DiagnosticsRequestLimiter : IDisposable
{
    private readonly SemaphoreSlim _requests;
    private readonly SemaphoreSlim _tails;

    public DiagnosticsRequestLimiter(IOptions<DiagnosticsOptions> options)
    {
        _requests = new(options.Value.MaximumConcurrentRequests, options.Value.MaximumConcurrentRequests);
        _tails = new(options.Value.MaximumTailSessions, options.Value.MaximumTailSessions);
    }

    public Lease? TryAcquireRequest() => TryAcquire(_requests);

    public Lease? TryAcquireTail() => TryAcquire(_tails);

    private static Lease? TryAcquire(SemaphoreSlim semaphore) =>
        semaphore.Wait(0) ? new Lease(semaphore) : null;

    public void Dispose()
    {
        _requests.Dispose();
        _tails.Dispose();
    }

    public sealed class Lease(SemaphoreSlim semaphore) : IDisposable
    {
        public void Dispose() => semaphore.Release();
    }
}

public static class DiagnosticsEndpointExtensions
{
    private const int MaximumControlPayloadBytes = 4096;
    private static readonly DateTimeOffset StartedAt = DateTimeOffset.UtcNow;

    public static void MapRealtimeDiagnostics(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        var metricsOptions = endpoints.ServiceProvider.GetRequiredService<IOptions<MetricsOptions>>().Value;
        if (metricsOptions.Enabled)
        {
            RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, metricsOptions.Path);
            var metrics = endpoints.MapGet(metricsOptions.Path, HandleMetricsAsync);
            if (!string.IsNullOrWhiteSpace(metricsOptions.AuthorizationPolicy))
            {
                metrics.RequireAuthorization(metricsOptions.AuthorizationPolicy);
            }
        }

        var options = endpoints.ServiceProvider.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        if (!options.Enabled)
        {
            return;
        }

        foreach (var route in ConcreteRoutes(options.BasePath))
        {
            RealtimeGatewayHostingExtensions.EnsureRouteAvailable(endpoints, route);
        }
        var group = endpoints.MapGroup(options.BasePath)
            .RequireCors(RealtimeGatewayHostingExtensions.DiagnosticsCorsPolicy)
            .RequireAuthorization(options.AuthorizationPolicy);
        group.MapGet("/snapshot", HandleSnapshotAsync);
        group.MapGet("/connections", HandleConnectionsAsync);
        group.MapGet("/events", HandleEventsAsync);
        group.MapGet("/logs/tail", HandleLogTailAsync);
        group.MapGet("/logging/overrides", HandleActiveOverridesAsync);
        group.MapGet("/logging/audit", HandleAuditAsync);
        group.MapPost("/logging/overrides", HandleApplyOverrideAsync);
        group.MapDelete("/logging/overrides/{id}", HandleRevertOverrideAsync);
    }

    private static async Task HandleMetricsAsync(HttpContext context)
    {
        var options = context.RequestServices.GetRequiredService<IOptions<MetricsOptions>>().Value;
        if (!IsNetworkAllowed(context, options.AllowedNetworks))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        var openMetrics = context.Request.GetTypedHeaders().Accept?.Any(item =>
            string.Equals(item.MediaType.Value, "application/openmetrics-text", StringComparison.OrdinalIgnoreCase)) == true;
        var body = context.RequestServices.GetRequiredService<GatewayMetrics>().RenderPrometheus();
        if (openMetrics)
        {
            body += "# EOF\n";
            context.Response.ContentType = "application/openmetrics-text; version=1.0.0; charset=utf-8";
        }
        else
        {
            context.Response.ContentType = "text/plain; version=0.0.4; charset=utf-8";
        }
        context.Response.Headers.CacheControl = "no-store";
        await context.Response.WriteAsync(body, context.RequestAborted);
    }

    private static async Task HandleSnapshotAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            var state = context.RequestServices.GetRequiredService<GatewayState>();
            var registry = context.RequestServices.GetRequiredService<RealtimeConnectionRegistry>();
            var metrics = context.RequestServices.GetRequiredService<GatewayMetrics>();
            var gateway = context.RequestServices.GetRequiredService<IOptions<GatewayOptions>>().Value;
            var identity = context.RequestServices.GetRequiredService<DiagnosticsIdentity>();
            var levels = context.RequestServices.GetRequiredService<RuntimeLogLevelController>();
            var realtime = context.RequestServices.GetRequiredService<IOptions<RealtimeOptions>>().Value;
            var diagnostics = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
            var metricsOptions = context.RequestServices.GetRequiredService<IOptions<MetricsOptions>>().Value;
            var aggregate = registry.GetAggregateSnapshot();
            using var process = Process.GetCurrentProcess();
            var response = new DiagnosticsSnapshotResponse(
                "1.0",
                DateTimeOffset.UtcNow,
                gateway.ServiceName,
                typeof(DiagnosticsEndpointExtensions).Assembly.GetName().Version?.ToString(3) ?? "0.0.0",
                identity.InstanceId,
                Math.Max(0, (long)(DateTimeOffset.UtcNow - StartedAt).TotalSeconds),
                await state.IsReadyAsync(context.RequestAborted) ? "ready" : state.IsDraining ? "draining" : "unavailable",
                new DiagnosticsEndpointSummary(
                    realtime.EndpointPath,
                    realtime.TicketEndpointPath,
                    metricsOptions.Path,
                    diagnostics.BasePath,
                    diagnostics.AllowedOrigins.Length,
                    diagnostics.AllowedNetworks.Length,
                    gateway.Topology),
                metrics.Snapshot(),
                aggregate.Connections,
                aggregate.AuthenticatedSessions,
                aggregate.Subscriptions,
                aggregate.QueuedMessages,
                GC.GetTotalMemory(false),
                process.TotalProcessorTime.TotalSeconds,
                levels.GetActive());
            await WriteJsonAsync(context, response, DiagnosticsJsonSerializerContext.Default.DiagnosticsSnapshotResponse);
        }
    }

    private static async Task HandleConnectionsAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
            var offset = ParseBoundedInt(context.Request.Query["offset"].ToString() ?? string.Empty, 0, 0, int.MaxValue);
            var limit = ParseBoundedInt(context.Request.Query["limit"].ToString() ?? string.Empty, 25, 1, options.MaximumDetailItems);
            if (offset is null || limit is null)
            {
                await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_page", "Offset or limit is invalid.");
                return;
            }
            var registry = context.RequestServices.GetRequiredService<RealtimeConnectionRegistry>();
            var response = new ConnectionDiagnosticsPage(
                DateTimeOffset.UtcNow,
                offset.Value,
                limit.Value,
                registry.Count,
                registry.GetDiagnostics(offset.Value, limit.Value));
            await WriteJsonAsync(context, response, DiagnosticsJsonSerializerContext.Default.ConnectionDiagnosticsPage);
        }
    }

    private static async Task HandleActiveOverridesAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            var response = context.RequestServices.GetRequiredService<RuntimeLogLevelController>().GetActive();
            await WriteJsonAsync(context, response, DiagnosticsJsonSerializerContext.Default.LogLevelOverrideResponseArray);
        }
    }

    private static async Task HandleAuditAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
            var offset = ParseBoundedInt(context.Request.Query["offset"].ToString() ?? string.Empty, 0, 0, int.MaxValue);
            var limit = ParseBoundedInt(context.Request.Query["limit"].ToString() ?? string.Empty, 25, 1, options.MaximumDetailItems);
            if (offset is null || limit is null)
            {
                await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_page", "Offset or limit is invalid.");
                return;
            }
            var response = await context.RequestServices.GetRequiredService<DiagnosticsControlService>()
                .GetAuditAsync(offset.Value, limit.Value, context.RequestAborted);
            await WriteJsonAsync(context, response, DiagnosticsJsonSerializerContext.Default.LogLevelAuditPage);
        }
    }

    private static async Task HandleApplyOverrideAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            LogLevelChangeRequest? request;
            if (context.Request.ContentLength is > MaximumControlPayloadBytes)
            {
                await WriteErrorAsync(context, StatusCodes.Status413PayloadTooLarge, "payload_too_large", "The request body is too large.");
                return;
            }
            try
            {
                var payload = new byte[MaximumControlPayloadBytes + 1];
                var length = 0;
                while (length < payload.Length)
                {
                    var read = await context.Request.Body.ReadAsync(payload.AsMemory(length), context.RequestAborted);
                    if (read == 0)
                    {
                        break;
                    }
                    length += read;
                }
                if (length > MaximumControlPayloadBytes)
                {
                    await WriteErrorAsync(context, StatusCodes.Status413PayloadTooLarge, "payload_too_large", "The request body is too large.");
                    return;
                }
                request = JsonSerializer.Deserialize(
                    payload.AsSpan(0, length),
                    DiagnosticsJsonSerializerContext.Default.LogLevelChangeRequest);
            }
            catch (JsonException)
            {
                await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_request", "The request body is invalid.");
                return;
            }
            if (request is null)
            {
                await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_request", "The request body is required.");
                return;
            }
            var actor = Actor(context);
            var outcome = await context.RequestServices.GetRequiredService<DiagnosticsControlService>()
                .ApplyAsync(request, actor, context.RequestAborted);
            if (!outcome.Succeeded)
            {
                var status = request.Scope == "all" && outcome.Error.Contains("Redis", StringComparison.Ordinal)
                    ? StatusCodes.Status503ServiceUnavailable
                    : StatusCodes.Status400BadRequest;
                await WriteErrorAsync(context, status, "log_level_rejected", outcome.Error);
                return;
            }
            context.Response.StatusCode = StatusCodes.Status201Created;
            await WriteJsonAsync(context, outcome.Result!, DiagnosticsJsonSerializerContext.Default.LogLevelOverrideResponse);
        }
    }

    private static async Task HandleRevertOverrideAsync(HttpContext context)
    {
        if (!TryEnter(context, out var lease))
        {
            return;
        }
        using (lease)
        {
            var id = context.Request.RouteValues["id"]?.ToString() ?? string.Empty;
            if (id.Length != 32 || !id.All(Uri.IsHexDigit))
            {
                await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_override", "The override identifier is invalid.");
                return;
            }
            var outcome = await context.RequestServices.GetRequiredService<DiagnosticsControlService>()
                .RevertAsync(id, Actor(context), context.RequestAborted);
            if (outcome.Succeeded)
            {
                context.Response.StatusCode = StatusCodes.Status204NoContent;
            }
            else if (outcome.Found)
            {
                await WriteErrorAsync(
                    context,
                    StatusCodes.Status503ServiceUnavailable,
                    "coordination_unavailable",
                    outcome.Error);
            }
            else
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
            }
        }
    }

    private static Task HandleEventsAsync(HttpContext context) => StreamEventsAsync(context);

    private static Task HandleLogTailAsync(HttpContext context) => StreamLogsAsync(context);

    private static async Task StreamEventsAsync(HttpContext context)
    {
        if (!TryEnterTail(context, out var lease))
        {
            return;
        }
        var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        var durationSeconds = ParseBoundedInt(
            context.Request.Query["durationSeconds"].ToString() ?? string.Empty,
            options.MaximumTailDurationSeconds,
            1,
            options.MaximumTailDurationSeconds);
        if (durationSeconds is null)
        {
            lease?.Dispose();
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_filter", "The stream duration is invalid.");
            return;
        }
        using (lease)
        await using (var subscription = context.RequestServices.GetRequiredService<DiagnosticsStreamHub>()
            .SubscribeEvents(options.TailBufferCapacity))
        {
            await PrepareEventStreamAsync(context);
            await StreamAsync(
                context,
                subscription.Reader,
                item => JsonSerializer.Serialize(item, DiagnosticsJsonSerializerContext.Default.DiagnosticOperationalEvent),
                _ => true,
                durationSeconds.Value);
        }
    }

    private static async Task StreamLogsAsync(HttpContext context)
    {
        if (!TryEnterTail(context, out var lease))
        {
            return;
        }
        var category = context.Request.Query["category"].ToString();
        var instance = context.Request.Query["instance"].ToString();
        var correlation = context.Request.Query["correlation"].ToString();
        var levelText = context.Request.Query["level"].ToString();
        var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        var durationSeconds = ParseBoundedInt(
            context.Request.Query["durationSeconds"].ToString() ?? string.Empty,
            options.MaximumTailDurationSeconds,
            1,
            options.MaximumTailDurationSeconds);
        var minimum = LogLevel.Information;
        var levelValid = string.IsNullOrEmpty(levelText) ||
            (Enum.TryParse<LogLevel>(levelText, true, out minimum) && Enum.IsDefined(minimum) && minimum is not LogLevel.None);
        if (category.Length > 128 || instance.Length > 128 || correlation.Length > 128 ||
            durationSeconds is null ||
            !levelValid)
        {
            lease?.Dispose();
            await WriteErrorAsync(context, StatusCodes.Status400BadRequest, "invalid_filter", "A log tail filter is invalid.");
            return;
        }
        using (lease)
        await using (var subscription = context.RequestServices.GetRequiredService<DiagnosticsStreamHub>()
            .SubscribeLogs(options.TailBufferCapacity))
        {
            await PrepareEventStreamAsync(context);
            await StreamAsync(
                context,
                subscription.Reader,
                item => JsonSerializer.Serialize(item, DiagnosticsJsonSerializerContext.Default.DiagnosticLogEvent),
                item => Enum.TryParse<LogLevel>(item.Level, out var itemLevel) && itemLevel >= minimum &&
                    (category.Length == 0 || item.Category.StartsWith(category, StringComparison.Ordinal)) &&
                    (instance.Length == 0 || item.InstanceId == instance) &&
                    (correlation.Length == 0 || item.CorrelationId == correlation),
                durationSeconds.Value);
        }
    }

    private static async Task StreamAsync<T>(
        HttpContext context,
        System.Threading.Channels.ChannelReader<T> reader,
        Func<T, string> serialize,
        Func<T, bool> include,
        int durationSeconds)
    {
        var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        using var duration = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        duration.CancelAfter(TimeSpan.FromSeconds(durationSeconds));
        var windowStarted = Stopwatch.GetTimestamp();
        var events = 0;
        var bytes = 0;
        try
        {
            while (!duration.IsCancellationRequested)
            {
                bool hasData;
                try
                {
                    hasData = await reader.WaitToReadAsync(duration.Token).AsTask()
                        .WaitAsync(TimeSpan.FromSeconds(15), duration.Token);
                }
                catch (TimeoutException)
                {
                    await context.Response.WriteAsync(": heartbeat\n\n", duration.Token);
                    await context.Response.Body.FlushAsync(duration.Token);
                    continue;
                }
                if (!hasData)
                {
                    break;
                }
                while (reader.TryRead(out var item))
                {
                    if (!include(item))
                    {
                        continue;
                    }
                    if (Stopwatch.GetElapsedTime(windowStarted) >= TimeSpan.FromSeconds(1))
                    {
                        windowStarted = Stopwatch.GetTimestamp();
                        events = 0;
                        bytes = 0;
                    }
                    var data = serialize(item);
                    events++;
                    bytes += System.Text.Encoding.UTF8.GetByteCount(data);
                    if (events > options.TailEventsPerSecond || bytes > options.TailBytesPerSecond)
                    {
                        await context.Response.WriteAsync("event: disconnect\ndata: {\"reason\":\"rate_limit\"}\n\n", duration.Token);
                        return;
                    }
                    await context.Response.WriteAsync($"data: {data}\n\n", duration.Token);
                    await context.Response.Body.FlushAsync(duration.Token);
                }
            }
        }
        catch (OperationCanceledException) when (duration.IsCancellationRequested)
        {
            // The configured timeout or client disconnect ended the bounded stream.
            return;
        }
    }

    internal static string[] ConcreteRoutes(string basePath) =>
    [
        $"{basePath}/snapshot",
        $"{basePath}/connections",
        $"{basePath}/events",
        $"{basePath}/logs/tail",
        $"{basePath}/logging/overrides",
        $"{basePath}/logging/overrides/{{id}}",
        $"{basePath}/logging/audit",
    ];

    private static Task PrepareEventStreamAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = "text/event-stream; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'";
        return context.Response.StartAsync(context.RequestAborted);
    }

    private static bool TryEnter(HttpContext context, out DiagnosticsRequestLimiter.Lease? lease)
    {
        lease = null;
        if (!IsDiagnosticsRequestAllowed(context))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }
        lease = context.RequestServices.GetRequiredService<DiagnosticsRequestLimiter>().TryAcquireRequest();
        if (lease is null)
        {
            context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            context.Response.Headers.RetryAfter = "1";
            return false;
        }
        return true;
    }

    private static bool TryEnterTail(HttpContext context, out DiagnosticsRequestLimiter.Lease? lease)
    {
        lease = null;
        if (!IsDiagnosticsRequestAllowed(context))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return false;
        }
        lease = context.RequestServices.GetRequiredService<DiagnosticsRequestLimiter>().TryAcquireTail();
        if (lease is null)
        {
            context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            context.Response.Headers.RetryAfter = "5";
            return false;
        }
        return true;
    }

    private static bool IsDiagnosticsRequestAllowed(HttpContext context)
    {
        var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        if (!IsNetworkAllowed(context, options.AllowedNetworks))
        {
            return false;
        }
        var origin = context.Request.Headers.Origin.ToString();
        return origin.Length == 0 || options.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);
    }

    private static bool IsNetworkAllowed(HttpContext context, string[] networks)
    {
        if (networks.Length == 0)
        {
            return true;
        }
        var address = context.Connection.RemoteIpAddress;
        return address is not null && networks.Any(network =>
            IPNetwork.TryParse(network, out var parsed) && parsed.Contains(address));
    }

    private static int? ParseBoundedInt(string value, int fallback, int minimum, int maximum)
    {
        if (string.IsNullOrEmpty(value))
        {
            return fallback;
        }
        return int.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var parsed) &&
            parsed >= minimum && parsed <= maximum ? parsed : null;
    }

    private static string Actor(HttpContext context) =>
        context.User.Identity?.Name ?? context.User.FindFirst("sub")?.Value ?? "authenticated-operator";

    private static async Task WriteErrorAsync(HttpContext context, int status, string code, string message)
    {
        context.Response.StatusCode = status;
        await WriteJsonAsync(context, new DiagnosticsError(code, message), DiagnosticsJsonSerializerContext.Default.DiagnosticsError);
    }

    private static async Task WriteJsonAsync<T>(
        HttpContext context,
        T value,
        System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> typeInfo)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers.CacheControl = "no-store";
        await JsonSerializer.SerializeAsync(context.Response.Body, value, typeInfo, context.RequestAborted);
    }
}
