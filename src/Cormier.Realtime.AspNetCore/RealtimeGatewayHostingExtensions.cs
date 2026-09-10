using System.Runtime.CompilerServices;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Microsoft.AspNetCore.ResponseCompression;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;

namespace Cormier.Realtime.AspNetCore;

public static class RealtimeGatewayHostingExtensions
{
    internal const string DiagnosticsCorsPolicy = "Cormier.Realtime.DiagnosticsOrigins";
    private static readonly ConditionalWeakTable<IEndpointRouteBuilder, object> MappedEndpoints = new();

    public static IServiceCollection AddRealtimeGateway(
        this IServiceCollection services,
        IConfiguration configuration,
        Action<RealtimeOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        services.AddOptions<GatewayOptions>()
            .Bind(configuration.GetSection(GatewayOptions.SectionName))
            .Validate(options => !string.IsNullOrWhiteSpace(options.ServiceName) && options.ServiceName.Length <= 128,
                "Gateway:ServiceName is required and must not exceed 128 characters.")
            .Validate(options => options.ShutdownDrainSeconds is >= 1 and <= 300,
                "Gateway:ShutdownDrainSeconds must be between 1 and 300.")
            .Validate(options => options.Topology is "ha" or "non-ha" or "unspecified",
                "Gateway:Topology must be 'ha', 'non-ha', or 'unspecified'.")
            .ValidateOnStart();

        services.AddOptions<RedisOptions>()
            .Bind(configuration.GetSection(RedisOptions.SectionName))
            .Validate(options => !string.IsNullOrWhiteSpace(options.Endpoint), "Redis:Endpoint is required.")
            .Validate(options => string.IsNullOrWhiteSpace(options.User) == string.IsNullOrWhiteSpace(options.Password),
                "Redis:User and Redis:Password must be supplied together.")
            .Validate(options => string.IsNullOrWhiteSpace(options.SentinelServiceName) || !options.Ssl,
                "Redis Sentinel discovery and direct TLS cannot be enabled together.")
            .Validate(options => string.IsNullOrWhiteSpace(options.SentinelServiceName) || !string.IsNullOrWhiteSpace(options.SentinelPassword),
                "Redis:SentinelPassword is required when Sentinel discovery is enabled.")
            .Validate(options => !string.IsNullOrWhiteSpace(options.InstancePrefix), "Redis:InstancePrefix is required.")
            .Validate(options => options.ConnectRetryCount is >= 1 and <= 20, "Redis:ConnectRetryCount must be between 1 and 20.")
            .Validate(options => options.StreamMaxLength is >= 100 and <= 1_000_000, "Redis:StreamMaxLength must be between 100 and 1000000.")
            .Validate(options => options.StreamReadCount is >= 1 and <= 1_000, "Redis:StreamReadCount must be between 1 and 1000.")
            .Validate(options => options.StreamClaimIdleMilliseconds is >= 1 and <= 3_600_000, "Redis:StreamClaimIdleMilliseconds must be between 1 and 3600000.")
            .Validate(options => options.StreamIdempotencyTtlSeconds is >= 60 and <= 2_592_000, "Redis:StreamIdempotencyTtlSeconds must be between 60 and 2592000.")
            .Validate(options => options.StreamPoisonMaxLength is >= 10 and <= 100_000, "Redis:StreamPoisonMaxLength must be between 10 and 100000.")
            .ValidateOnStart();

        services.AddOptions<ProxyOptions>()
            .Bind(configuration.GetSection(ProxyOptions.SectionName))
            .Validate(options => options.TrustedNetworks.All(network => System.Net.IPNetwork.TryParse(network, out _)),
                "Proxy:TrustedNetworks must contain valid CIDR ranges.")
            .ValidateOnStart();

        services.AddOptions<DiagnosticsOptions>()
            .Bind(configuration.GetSection(DiagnosticsOptions.SectionName))
            .Validate(options => !options.Enabled || IsValidRoute(options.BasePath),
                "Diagnostics:BasePath must be an absolute route without query or fragment.")
            .Validate(options => !options.Enabled || !string.IsNullOrWhiteSpace(options.AuthorizationPolicy),
                "Diagnostics:AuthorizationPolicy is required when diagnostics are enabled.")
            .Validate(options => options.AllowedOrigins.All(IsAbsoluteOrigin),
                "Diagnostics:AllowedOrigins must contain HTTP or HTTPS origins without paths, queries, or fragments.")
            .Validate(options => options.AllowedNetworks.All(network => System.Net.IPNetwork.TryParse(network, out _)),
                "Diagnostics:AllowedNetworks must contain valid CIDR ranges.")
            .Validate(options => options.LogCategoryAllowlist.Length > 0 && options.LogCategoryAllowlist.All(category =>
                    !string.IsNullOrWhiteSpace(category) && category.Length <= 128),
                "Diagnostics:LogCategoryAllowlist must contain bounded category prefixes.")
            .Validate(options => options.MaximumDetailItems is >= 1 and <= 1000,
                "Diagnostics:MaximumDetailItems must be between 1 and 1000.")
            .Validate(options => options.MaximumConcurrentRequests is >= 1 and <= 100,
                "Diagnostics:MaximumConcurrentRequests must be between 1 and 100.")
            .Validate(options => options.MaximumTailSessions is >= 1 and <= 100,
                "Diagnostics:MaximumTailSessions must be between 1 and 100.")
            .Validate(options => options.TailBufferCapacity is >= 1 and <= 10_000,
                "Diagnostics:TailBufferCapacity must be between 1 and 10000.")
            .Validate(options => options.TailEventsPerSecond is >= 1 and <= 10_000,
                "Diagnostics:TailEventsPerSecond must be between 1 and 10000.")
            .Validate(options => options.TailBytesPerSecond is >= 1024 and <= 10_485_760,
                "Diagnostics:TailBytesPerSecond must be between 1024 and 10485760.")
            .Validate(options => options.MaximumTailDurationSeconds is >= 30 and <= 3600,
                "Diagnostics:MaximumTailDurationSeconds must be between 30 and 3600.")
            .Validate(options => options.MinimumLogOverrideSeconds is >= 10 and <= 300,
                "Diagnostics:MinimumLogOverrideSeconds must be between 10 and 300.")
            .Validate(options => options.MaximumLogOverrideSeconds >= options.MinimumLogOverrideSeconds &&
                    options.MaximumLogOverrideSeconds <= 86400,
                "Diagnostics:MaximumLogOverrideSeconds must be at least the minimum and no more than 86400.")
            .Validate(options => options.AuditCapacity is >= 10 and <= 10_000,
                "Diagnostics:AuditCapacity must be between 10 and 10000.")
            .Validate(options => options.AuditRetentionDays is >= 1 and <= 365,
                "Diagnostics:AuditRetentionDays must be between 1 and 365.")
            .ValidateOnStart();

        services.AddOptions<MetricsOptions>()
            .Bind(configuration.GetSection(MetricsOptions.SectionName))
            .Validate(options => !options.Enabled || IsValidRoute(options.Path),
                "Metrics:Path must be an absolute route without query or fragment.")
            .Validate(options => options.AllowedNetworks.All(network => System.Net.IPNetwork.TryParse(network, out _)),
                "Metrics:AllowedNetworks must contain valid CIDR ranges.")
            .ValidateOnStart();

        var realtime = services.AddOptions<RealtimeOptions>()
            .Bind(configuration.GetSection(RealtimeOptions.SectionName));
        if (configure is not null)
        {
            realtime.Configure(configure);
        }
        realtime
            .Validate(options => IsValidRoute(options.EndpointPath), "Realtime:EndpointPath must be an absolute route without query or fragment.")
            .Validate(options => IsValidRoute(options.TicketEndpointPath), "Realtime:TicketEndpointPath must be an absolute route without query or fragment.")
            .Validate(options => !string.Equals(options.EndpointPath, options.TicketEndpointPath, StringComparison.OrdinalIgnoreCase),
                "Realtime endpoint and ticket endpoint paths must be different.")
            .Validate(options => options.SessionSource != RealtimeSessionSource.Cookie || !string.IsNullOrWhiteSpace(options.SessionCookieName),
                "Realtime:SessionCookieName is required for cookie session resolution.")
            .Validate(options => options.SessionSource != RealtimeSessionSource.AspNetCoreSession || !string.IsNullOrWhiteSpace(options.AspNetCoreSessionIdKey),
                "Realtime:AspNetCoreSessionIdKey is required for ASP.NET Core session resolution.")
            .Validate(options => options.AllowedOrigins.Length > 0 && options.AllowedOrigins.All(IsAbsoluteOrigin),
                "Realtime:AllowedOrigins must contain HTTP or HTTPS origins without paths, queries, or fragments.")
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

        services.TryAddEnumerable(ServiceDescriptor.Singleton<IValidateOptions<RealtimeOptions>, RealtimeOptionsValidator>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IValidateOptions<DiagnosticsOptions>, DiagnosticsEnvironmentValidator>());
        services.AddOptions<ForwardedHeadersOptions>().Configure<IOptions<ProxyOptions>>((headers, proxy) =>
        {
            headers.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
            headers.ForwardLimit = 1;
            headers.KnownIPNetworks.Clear();
            foreach (var network in proxy.Value.TrustedNetworks)
            {
                headers.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
            }
        });
        services.AddOptions<HostOptions>().Configure<IOptions<GatewayOptions>>((host, gateway) =>
            host.ShutdownTimeout = TimeSpan.FromSeconds(gateway.Value.ShutdownDrainSeconds + 5));
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, DiagnosticsJsonSerializerContext.Default);
            options.SerializerOptions.TypeInfoResolverChain.Insert(0, RealtimeJsonSerializerContext.Default);
        });

        services.AddResponseCompression(options =>
        {
            options.EnableForHttps = true;
            options.Providers.Add<GzipCompressionProvider>();
            options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
                ["application/openmetrics-text", "text/event-stream"]);
        });
        services.AddCors(options => options.AddPolicy(DiagnosticsCorsPolicy, policy =>
        {
            var origins = configuration.GetSection($"{DiagnosticsOptions.SectionName}:AllowedOrigins").Get<string[]>() ?? [];
            if (origins.Length > 0)
            {
                policy.WithOrigins(origins)
                    .AllowAnyMethod()
                    .AllowAnyHeader();
            }
        }));

        if (configuration.GetValue<bool>($"{MetricsOptions.SectionName}:OtlpEnabled"))
        {
            var serviceName = configuration[$"{GatewayOptions.SectionName}:ServiceName"] ?? "cormier-realtime-gateway";
            services.AddOpenTelemetry()
                .ConfigureResource(resource => resource.AddService(serviceName))
                .WithMetrics(metrics => metrics
                    .AddMeter("Cormier.Realtime.Gateway")
                    .AddView(
                        "cormier_realtime_connection_duration_seconds",
                        new ExplicitBucketHistogramConfiguration
                        {
                            Boundaries = GatewayMetrics.ConnectionDurationBucketBoundaries,
                        })
                    .AddView(
                        "cormier_realtime_handler_duration_seconds",
                        new ExplicitBucketHistogramConfiguration
                        {
                            Boundaries = GatewayMetrics.DurationBucketBoundaries,
                        })
                    .AddView(
                        "cormier_realtime_redis_operation_duration_seconds",
                        new ExplicitBucketHistogramConfiguration
                        {
                            Boundaries = GatewayMetrics.DurationBucketBoundaries,
                        })
                    .AddOtlpExporter());
        }

        services.TryAddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<GatewayOptions>>().Value);
        services.TryAddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<RedisOptions>>().Value);
        services.TryAddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<RealtimeOptions>>().Value);
        services.TryAddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<DiagnosticsOptions>>().Value);
        services.TryAddSingleton(serviceProvider => serviceProvider.GetRequiredService<IOptions<MetricsOptions>>().Value);
        services.TryAddSingleton<RedisConnectionProvider>();
        services.TryAddSingleton<IRedisReadinessProbe>(serviceProvider => serviceProvider.GetRequiredService<RedisConnectionProvider>());
        services.TryAddSingleton<IRealtimeSessionStore, RedisSessionStore>();
        services.TryAddSingleton<IConnectionTicketStore, RedisConnectionTicketStore>();
        services.TryAddSingleton<IRealtimeMessageBus, RedisRealtimeMessageBus>();
        services.TryAddSingleton<IDurableRealtimeStore, RedisDurableRealtimeStore>();
        services.TryAddSingleton<IRealtimeSessionResolver, RealtimeSessionResolver>();
        services.TryAddSingleton<GatewayState>();
        services.TryAddSingleton<RedisSubscriptionState>();
        services.TryAddSingleton<GatewayMetrics>();
        services.TryAddSingleton<RealtimeConnectionRegistry>();
        services.TryAddSingleton<RealtimeAuthenticator>();
        services.TryAddSingleton<RealtimeDispatcher>();
        services.TryAddSingleton<RealtimeWebSocketHandler>();
        services.TryAddSingleton<DiagnosticsIdentity>();
        services.TryAddSingleton<DiagnosticsStreamHub>();
        services.TryAddSingleton<RuntimeLogLevelController>();
        services.TryAddSingleton<DiagnosticsRequestLimiter>();
        services.TryAddSingleton<DiagnosticsControlService>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<ILoggerProvider, DiagnosticsLoggerProvider>());
        services.AddOptions<LoggerFilterOptions>()
            .PostConfigure<RuntimeLogLevelController>((logging, controller) =>
            {
                var baselineMinimum = logging.MinLevel;
                var baselineRules = logging.Rules.ToArray();
                foreach (var rule in baselineRules)
                {
                    logging.Rules.Add(new LoggerFilterRule(
                        rule.ProviderName,
                        rule.CategoryName,
                        logLevel: LogLevel.Trace,
                        filter: (provider, category, level) => controller.HasOverride(category ?? string.Empty)
                            ? level >= controller.EffectiveLevel(category ?? string.Empty)
                            : level >= (rule.LogLevel ?? LogLevel.Trace) &&
                                (rule.Filter?.Invoke(provider, category, level) ?? true)));
                }
                logging.Rules.Add(new LoggerFilterRule(
                    providerName: null,
                    categoryName: null,
                    logLevel: LogLevel.Trace,
                    filter: (_, category, level) => controller.HasOverride(category ?? string.Empty)
                        ? level >= controller.EffectiveLevel(category ?? string.Empty)
                        : level >= baselineMinimum));
            });
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, RedisSubscriberService>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, GatewayDrainService>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, RealtimeGatewayStartupService>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, DiagnosticsSamplerService>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, DiagnosticsCoordinationService>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, DiagnosticsAuditPersistenceService>());
        return services;
    }

    public static IApplicationBuilder UseRealtimeGateway(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var options = app.ApplicationServices.GetRequiredService<RealtimeOptions>();
        app.UseForwardedHeaders();
        app.UseResponseCompression();
        app.Use(HandleDiagnosticsPreflightAsync);
        app.UseCors();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(options.HeartbeatSeconds) });
        return app;
    }

    private static async Task HandleDiagnosticsPreflightAsync(HttpContext context, RequestDelegate next)
    {
        var options = context.RequestServices.GetRequiredService<IOptions<DiagnosticsOptions>>().Value;
        var origin = context.Request.Headers.Origin.ToString();
        var requestedMethod = context.Request.Headers.AccessControlRequestMethod.ToString();
        if (options.Enabled &&
            HttpMethods.IsOptions(context.Request.Method) &&
            context.Request.Path.StartsWithSegments(options.BasePath) &&
            requestedMethod.Length > 0 &&
            options.AllowedOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status204NoContent;
            context.Response.Headers.AccessControlAllowOrigin = origin;
            context.Response.Headers.AccessControlAllowMethods = requestedMethod;
            var requestedHeaders = context.Request.Headers.AccessControlRequestHeaders.ToString();
            if (requestedHeaders.Length > 0)
            {
                context.Response.Headers.AccessControlAllowHeaders = requestedHeaders;
            }
            context.Response.Headers.Append("Vary", "Origin");
            return;
        }
        await next(context);
    }

    public static IEndpointConventionBuilder MapRealtimeGateway(this IEndpointRouteBuilder endpoints)
    {
        ArgumentNullException.ThrowIfNull(endpoints);
        lock (MappedEndpoints)
        {
            if (MappedEndpoints.TryGetValue(endpoints, out _))
            {
                throw new InvalidOperationException("MapRealtimeGateway may only be called once for an endpoint route builder.");
            }
            MappedEndpoints.Add(endpoints, new object());
        }

        var options = endpoints.ServiceProvider.GetRequiredService<RealtimeOptions>();
        EnsureRouteAvailable(endpoints, options.EndpointPath);
        EnsureRouteAvailable(endpoints, options.TicketEndpointPath);
        var socket = endpoints.MapGet(options.EndpointPath, (RequestDelegate)HandleSocketAsync);
        var tickets = endpoints.MapPost(options.TicketEndpointPath, (RequestDelegate)IssueTicketAsync);
        if (!string.IsNullOrWhiteSpace(options.AuthorizationPolicy))
        {
            socket.RequireAuthorization(options.AuthorizationPolicy);
            tickets.RequireAuthorization(options.AuthorizationPolicy);
        }
        return new CompositeEndpointConventionBuilder(socket, tickets);
    }

    private static Task HandleSocketAsync(HttpContext context) =>
        context.RequestServices.GetRequiredService<RealtimeWebSocketHandler>().HandleAsync(context);

    private static async Task IssueTicketAsync(HttpContext context)
    {
        var authenticator = context.RequestServices.GetRequiredService<RealtimeAuthenticator>();
        var options = context.RequestServices.GetRequiredService<RealtimeOptions>();
        var authentication = await authenticator.AuthenticateSessionAsync(context, context.RequestAborted);
        if (!authentication.Succeeded)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        var now = DateTimeOffset.UtcNow;
        var expiresAt = authentication.Identity!.ExpiresAt < now.AddSeconds(options.TicketLifetimeSeconds)
            ? authentication.Identity.ExpiresAt
            : now.AddSeconds(options.TicketLifetimeSeconds);
        if (expiresAt <= now)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }
        var ticket = await authenticator.IssueTicketAsync(authentication.Identity, context.Request.Host.Value ?? string.Empty,
            expiresAt - now, context.RequestAborted);
        context.Response.ContentType = "application/json; charset=utf-8";
        await System.Text.Json.JsonSerializer.SerializeAsync(
            context.Response.Body,
            new ConnectionTicketResponse(ticket, expiresAt),
            RealtimeJsonSerializerContext.Default.ConnectionTicketResponse,
            context.RequestAborted);
    }

    private static void EnsureRouteAvailable(IEndpointRouteBuilder endpoints, string route)
    {
        if (endpoints.DataSources.SelectMany(source => source.Endpoints).OfType<RouteEndpoint>()
            .Any(endpoint => string.Equals(endpoint.RoutePattern.RawText, route, StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException($"The endpoint route '{route}' is already mapped.");
        }
    }

    private static bool IsValidRoute(string route)
    {
        if (string.IsNullOrWhiteSpace(route) || route[0] != '/' ||
            route.Contains('?', StringComparison.Ordinal) || route.Contains('#', StringComparison.Ordinal))
        {
            return false;
        }

        try
        {
            return RoutePatternFactory.Parse(route).PathSegments.Count > 0;
        }
        catch (RoutePatternException)
        {
            return false;
        }
    }

    private static bool IsAbsoluteOrigin(string value) => Uri.TryCreate(value, UriKind.Absolute, out var origin) &&
        (origin.Scheme == Uri.UriSchemeHttp || origin.Scheme == Uri.UriSchemeHttps) &&
        origin.AbsolutePath == "/" && string.IsNullOrEmpty(origin.Query) && string.IsNullOrEmpty(origin.Fragment);

    private sealed class CompositeEndpointConventionBuilder(params IEndpointConventionBuilder[] builders) : IEndpointConventionBuilder
    {
        public void Add(Action<EndpointBuilder> convention)
        {
            foreach (var builder in builders)
            {
                builder.Add(convention);
            }
        }
    }
}

internal sealed class RealtimeGatewayStartupService(GatewayState state) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        state.MarkStarted();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
