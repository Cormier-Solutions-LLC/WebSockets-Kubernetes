using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using Cormier.Realtime.AspNetCore;
using Cormier.Realtime.Gateway;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Hosting;

namespace Cormier.Realtime.IntegrationTests;

public sealed class DiagnosticsEndpointTests
{
    private static readonly string[] InvalidNumericLogTailPaths = [.. new[] { "-1", "7" }
        .Select(static level => $"/diagnostics/v1/logs/tail?level={level}")];

    [Fact]
    public async Task BuiltInDiagnosticsBearerRequiresTheConfiguredRuntimeCredential()
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var metricsToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddRealtimeDiagnosticsBearer("diagnostics-operator", token);
        builder.Services.AddRealtimeMetricsBearer("metrics-operator", metricsToken);
        Assert.Throws<ArgumentException>(() => builder.Services.AddRealtimeDiagnosticsBearer(
            "invalid-token-policy",
            $"{token}\n"));
        await using var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapGet("/secured-diagnostics", () => Results.Ok()).RequireAuthorization("diagnostics-operator");
        app.MapGet("/secured-metrics", () => Results.Ok()).RequireAuthorization("metrics-operator");
        await app.StartAsync();
        using var client = app.GetTestClient();

        using var anonymous = await client.GetAsync("/secured-diagnostics", CancellationToken.None);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        using var invalidRequest = new HttpRequestMessage(HttpMethod.Get, "/secured-diagnostics");
        invalidRequest.Headers.Authorization = new("Bearer", Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
        using var invalid = await client.SendAsync(invalidRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Unauthorized, invalid.StatusCode);

        using var validRequest = new HttpRequestMessage(HttpMethod.Get, "/secured-diagnostics");
        validRequest.Headers.Authorization = new("Bearer", token);
        using var valid = await client.SendAsync(validRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, valid.StatusCode);

        using var metricsRequest = new HttpRequestMessage(HttpMethod.Get, "/secured-metrics");
        metricsRequest.Headers.Authorization = new("Bearer", metricsToken);
        using var metrics = await client.SendAsync(metricsRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, metrics.StatusCode);

        using var diagnosticsCredentialOnMetrics = new HttpRequestMessage(HttpMethod.Get, "/secured-metrics");
        diagnosticsCredentialOnMetrics.Headers.Authorization = new("Bearer", token);
        using var rejectedMetrics = await client.SendAsync(diagnosticsCredentialOnMetrics, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Unauthorized, rejectedMetrics.StatusCode);

        using var metricsCredentialOnDiagnostics = new HttpRequestMessage(HttpMethod.Get, "/secured-diagnostics");
        metricsCredentialOnDiagnostics.Headers.Authorization = new("Bearer", metricsToken);
        using var rejectedDiagnostics = await client.SendAsync(metricsCredentialOnDiagnostics, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Unauthorized, rejectedDiagnostics.StatusCode);
    }

    [Fact]
    public async Task DiagnosticsRequireOperatorPolicyAndAllowedOrigin()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();

        using var anonymous = await client.GetAsync("/diagnostics/v1/snapshot", CancellationToken.None);
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        using var wrongOriginRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/snapshot");
        wrongOriginRequest.Headers.Add("Origin", "https://untrusted.example");
        using var wrongOrigin = await client.SendAsync(wrongOriginRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Forbidden, wrongOrigin.StatusCode);

        using var allowedRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/snapshot");
        allowedRequest.Headers.Add("Origin", "https://operator.example");
        using var allowed = await client.SendAsync(allowedRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Assert.Equal("https://operator.example", allowed.Headers.GetValues("Access-Control-Allow-Origin").Single());
        var snapshot = await allowed.Content.ReadFromJsonAsync(
            DiagnosticsJsonSerializerContext.Default.DiagnosticsSnapshotResponse,
            CancellationToken.None);

        Assert.NotNull(snapshot);
        Assert.Equal("1.0", snapshot.ContractVersion);
        Assert.DoesNotContain("tenant", await allowed.Content.ReadAsStringAsync(CancellationToken.None), StringComparison.OrdinalIgnoreCase);

    }

    [Fact]
    public async Task AllowedBrowserOriginCanCompleteBearerPreflightWithoutAuthentication()
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development,
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Diagnostics:Enabled"] = "true",
            ["Diagnostics:AuthorizationPolicy"] = "diagnostics-operator",
            ["Diagnostics:AllowedOrigins:0"] = "https://operator.example",
            ["Realtime:AllowedOrigins:0"] = "http://localhost",
            ["Redis:Endpoint"] = "redis.invalid:6379",
        });
        builder.Services.AddRealtimeGateway(builder.Configuration);
        builder.Services.AddAuthentication("test")
            .AddScheme<AuthenticationSchemeOptions, TestAuthenticationHandler>("test", _ => { });
        builder.Services.AddAuthorization(options => options.AddPolicy(
            "diagnostics-operator",
            policy => policy.RequireAuthenticatedUser()));
        await using var app = builder.Build();
        app.UseRealtimeGateway();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapRealtimeDiagnostics();
        await app.StartAsync();
        using var client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/diagnostics/v1/snapshot");
        request.Headers.Add("Origin", "https://operator.example");
        request.Headers.Add("Access-Control-Request-Method", "GET");
        request.Headers.Add("Access-Control-Request-Headers", "Authorization");

        using var response = await client.SendAsync(request, CancellationToken.None);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("https://operator.example", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Contains("Authorization", response.Headers.GetValues("Access-Control-Allow-Headers").Single(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DiagnosticsFailClosedWhenSourceNetworkCannotBeVerified()
    {
        await using var factory = CreateFactory(clearAllowedNetworks: false);
        using var client = factory.CreateClient();
        using var request = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/snapshot");

        using var response = await client.SendAsync(request, CancellationToken.None);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task InstanceLogOverrideIsValidatedAuditedAndRevertedWithoutRedis()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        using var apply = OperatorRequest(HttpMethod.Post, "/diagnostics/v1/logging/overrides");
        apply.Content = JsonContent.Create(
            new LogLevelChangeRequest("Cormier.Realtime", "Debug", 30, "integration verification", "instance"),
            DiagnosticsJsonSerializerContext.Default.LogLevelChangeRequest);

        using var appliedResponse = await client.SendAsync(apply, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Created, appliedResponse.StatusCode);
        var applied = await appliedResponse.Content.ReadFromJsonAsync(
            DiagnosticsJsonSerializerContext.Default.LogLevelOverrideResponse,
            CancellationToken.None);

        Assert.NotNull(applied);
        using var activeRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/logging/overrides");
        using var activeResponse = await client.SendAsync(activeRequest, CancellationToken.None);
        var active = await activeResponse.Content.ReadFromJsonAsync(
            DiagnosticsJsonSerializerContext.Default.LogLevelOverrideResponseArray,
            CancellationToken.None);
        Assert.Contains(active!, item => item.Id == applied.Id);

        using var revertRequest = OperatorRequest(HttpMethod.Delete, $"/diagnostics/v1/logging/overrides/{applied.Id}");
        using var reverted = await client.SendAsync(revertRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.NoContent, reverted.StatusCode);

        using var auditRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/logging/audit");
        using var auditResponse = await client.SendAsync(auditRequest, CancellationToken.None);
        var audit = await auditResponse.Content.ReadFromJsonAsync(
            DiagnosticsJsonSerializerContext.Default.LogLevelAuditPage,
            CancellationToken.None);
        Assert.NotNull(audit);
        Assert.Contains(audit.Items, item => item.Id == applied.Id && item.Outcome == "applied");
        Assert.Contains(audit.Items, item => item.Id == applied.Id && item.Outcome == "reverted");
    }

    [Fact]
    public async Task LogOverridePayloadAndCategoryAreBounded()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        using var categoryRequest = OperatorRequest(HttpMethod.Post, "/diagnostics/v1/logging/overrides");
        categoryRequest.Content = JsonContent.Create(
            new LogLevelChangeRequest($"Cormier.Realtime.{new string('x', 129)}", "Debug", 30, "bounded category", "instance"),
            DiagnosticsJsonSerializerContext.Default.LogLevelChangeRequest);
        using var categoryResponse = await client.SendAsync(categoryRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.BadRequest, categoryResponse.StatusCode);

        using var payloadRequest = OperatorRequest(HttpMethod.Post, "/diagnostics/v1/logging/overrides");
        payloadRequest.Content = new StringContent(new string('x', 4097));
        using var payloadResponse = await client.SendAsync(payloadRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, payloadResponse.StatusCode);
    }

    [Fact]
    public async Task RuntimeOverrideTakesPrecedenceOverCategorySpecificLoggingRule()
    {
        await using var factory = CreateFactory(new Dictionary<string, string?>
        {
            ["Logging:LogLevel:Cormier.Realtime"] = "Warning",
        });
        using var client = factory.CreateClient();
        using var apply = OperatorRequest(HttpMethod.Post, "/diagnostics/v1/logging/overrides");
        apply.Content = JsonContent.Create(
            new LogLevelChangeRequest("Cormier.Realtime", "Debug", 30, "capture category debug output", "instance"),
            DiagnosticsJsonSerializerContext.Default.LogLevelChangeRequest);
        using var applied = await client.SendAsync(apply, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Created, applied.StatusCode);

        using var tail = OperatorRequest(
            HttpMethod.Get,
            "/diagnostics/v1/logs/tail?level=Debug&category=Cormier.Realtime&durationSeconds=2");
        var responseTask = client.SendAsync(tail, HttpCompletionOption.ResponseHeadersRead, CancellationToken.None);
        var logger = factory.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Cormier.Realtime.OverrideFixture");
        var loggingOptions = factory.Services.GetRequiredService<IOptions<LoggerFilterOptions>>().Value;
        var rules = string.Join(";", loggingOptions.Rules.Select(rule =>
            $"{rule.ProviderName ?? "*"}|{rule.CategoryName ?? "*"}|{rule.LogLevel}|{rule.Filter is not null}"));
        Assert.True(logger.IsEnabled(LogLevel.Debug), rules);
        for (var attempt = 0; attempt < 5; attempt++)
        {
            await Task.Delay(100);
            logger.Log(
                LogLevel.Debug,
                new EventId(9010, "OverrideFixture"),
                "category override marker",
                null,
                static (state, _) => state);
        }

        using var response = await responseTask;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var content = await response.Content.ReadAsStringAsync(timeout.Token);
        Assert.Contains("category override marker", content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LiveLogTailRejectsInvalidFiltersAndStreamsRedactedRecords()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        using var invalidRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/logs/tail?level=not-a-level");
        using var invalid = await client.SendAsync(invalidRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        foreach (var path in InvalidNumericLogTailPaths)
        {
            using var numericRequest = OperatorRequest(HttpMethod.Get, path);
            using var numeric = await client.SendAsync(numericRequest, CancellationToken.None);
            Assert.Equal(HttpStatusCode.BadRequest, numeric.StatusCode);
        }

        using var tailRequest = OperatorRequest(
            HttpMethod.Get,
            "/diagnostics/v1/logs/tail?level=Warning&category=Cormier.Realtime&durationSeconds=5");
        var responseTask = client.SendAsync(
            tailRequest,
            HttpCompletionOption.ResponseHeadersRead,
            CancellationToken.None);

        var logger = factory.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Cormier.Realtime.Security");
        for (var attempt = 0; attempt < 5; attempt++)
        {
            await Task.Delay(100);
            logger.Log(
                LogLevel.Warning,
                new EventId(9001, "SensitiveTailFixture"),
                "Authorization: Bearer tail-credential tenantId=private-tenant",
                null,
                static (state, _) => state);
        }

        using var response = await responseTask;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
        using var reader = new StreamReader(stream);
        string? data = null;
        while (!timeout.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(timeout.Token);
            if (line is null)
            {
                break;
            }
            if (line.StartsWith("data: ", StringComparison.Ordinal) &&
                line.Contains("\"eventId\":9001", StringComparison.Ordinal))
            {
                data = line;
                break;
            }
        }
        Assert.NotNull(data);
        Assert.Contains("[REDACTED]", data, StringComparison.Ordinal);
        Assert.DoesNotContain("tail-credential", data, StringComparison.Ordinal);
        Assert.DoesNotContain("private-tenant", data, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReplicaWideLogOverrideFailsClosedDuringRedisInterruption()
    {
        await using var factory = CreateFactory();
        using var client = factory.CreateClient();
        using var apply = OperatorRequest(HttpMethod.Post, "/diagnostics/v1/logging/overrides");
        apply.Content = JsonContent.Create(
            new LogLevelChangeRequest("Cormier.Realtime", "Debug", 30, "Redis interruption verification", "all"),
            DiagnosticsJsonSerializerContext.Default.LogLevelChangeRequest);

        using var response = await client.SendAsync(apply, CancellationToken.None);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);

        using var activeRequest = OperatorRequest(HttpMethod.Get, "/diagnostics/v1/logging/overrides");
        using var activeResponse = await client.SendAsync(activeRequest, CancellationToken.None);
        var active = await activeResponse.Content.ReadFromJsonAsync(
            DiagnosticsJsonSerializerContext.Default.LogLevelOverrideResponseArray,
            CancellationToken.None);
        Assert.Empty(active!);
    }

    [Fact]
    public async Task LiveLogTailDisconnectsAtRateLimitAndReleasesItsSession()
    {
        await using var factory = CreateFactory(new Dictionary<string, string?>
        {
            ["Diagnostics:MaximumTailSessions"] = "1",
            ["Diagnostics:TailEventsPerSecond"] = "2",
        });
        using var client = factory.CreateClient();
        using var tailRequest = OperatorRequest(
            HttpMethod.Get,
            "/diagnostics/v1/logs/tail?level=Warning&category=Cormier.Realtime&durationSeconds=10");
        var responseTask = client.SendAsync(
            tailRequest,
            HttpCompletionOption.ResponseHeadersRead,
            CancellationToken.None);

        var logger = factory.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Cormier.Realtime.Burst");
        for (var eventId = 1; eventId <= 5; eventId++)
        {
            await Task.Delay(100);
            logger.Log(
                LogLevel.Warning,
                new EventId(eventId, "BurstFixture"),
                "bounded burst",
                null,
                static (state, _) => state);
        }

        using var response = await responseTask;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var stream = await response.Content.ReadAsStringAsync(timeout.Token);
        Assert.Contains("event: disconnect", stream, StringComparison.Ordinal);
        Assert.Contains("\"reason\":\"rate_limit\"", stream, StringComparison.Ordinal);

        using var nextRequest = OperatorRequest(
            HttpMethod.Get,
            "/diagnostics/v1/logs/tail?durationSeconds=1");
        using var next = await client.SendAsync(nextRequest, CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, next.StatusCode);
    }

    private static WebApplicationFactory<Program> CreateFactory(
        IReadOnlyDictionary<string, string?>? overrides = null,
        bool clearAllowedNetworks = true) => new DiagnosticsWebApplicationFactory(overrides, clearAllowedNetworks);

    private sealed class DiagnosticsWebApplicationFactory(
        IReadOnlyDictionary<string, string?>? overrides,
        bool clearAllowedNetworks) : WebApplicationFactory<Program>
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Development");
            builder.ConfigureAppConfiguration((_, configuration) =>
            {
                var settings = new Dictionary<string, string?>
                {
                    ["Diagnostics:Enabled"] = "true",
                    ["Diagnostics:AuthorizationPolicy"] = "diagnostics-operator",
                    ["Diagnostics:AllowedOrigins:0"] = "https://operator.example",
                    ["Diagnostics:AllowedNetworks:0"] = "0.0.0.0/0",
                    ["Diagnostics:AllowedNetworks:1"] = "::/0",
                    ["Diagnostics:MaximumTailDurationSeconds"] = "30",
                    ["Redis:Endpoint"] = "redis.invalid:6379",
                    ["Redis:ConnectTimeoutMilliseconds"] = "100",
                };
                if (overrides is not null)
                {
                    foreach (var (key, value) in overrides)
                    {
                        settings[key] = value;
                    }
                }
                configuration.AddInMemoryCollection(settings);
            });
            builder.ConfigureServices(services =>
            {
                if (clearAllowedNetworks)
                {
                    services.PostConfigure<DiagnosticsOptions>(options => options.AllowedNetworks = []);
                }
                var coordinationServices = services
                    .Where(descriptor => descriptor.ServiceType == typeof(IHostedService) &&
                        descriptor.ImplementationType is not null &&
                        (descriptor.ImplementationType == typeof(DiagnosticsCoordinationService) ||
                            descriptor.ImplementationType.Name == "RedisSubscriberService"))
                    .ToArray();
                foreach (var descriptor in coordinationServices)
                {
                    services.Remove(descriptor);
                }
                services.AddAuthentication("test")
                    .AddScheme<AuthenticationSchemeOptions, TestAuthenticationHandler>("test", _ => { });
                services.AddAuthorization(options => options.AddPolicy(
                    "diagnostics-operator",
                    policy => policy.RequireAuthenticatedUser()));
            });
        }
    }

    private static HttpRequestMessage OperatorRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Add("X-Test-Operator", "true");
        return request;
    }

    private sealed class TestAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (!Request.Headers.TryGetValue("X-Test-Operator", out var value) || value != "true")
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }
            var identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, "integration-operator")], Scheme.Name);
            return Task.FromResult(AuthenticateResult.Success(
                new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
        }
    }
}
