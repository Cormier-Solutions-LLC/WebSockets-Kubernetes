using Cormier.Realtime.AspNetCore;
using Cormier.Realtime.Contracts;
using Cormier.Realtime.Gateway;
using Cormier.Realtime.Redis;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Cormier.Realtime.UnitTests;

public sealed class AspNetCoreHostingIntegrationTests
{
    [Fact]
    public async Task AddRealtimeGatewayBindsConfigurationAndRegistersPublicIntegrationServices()
    {
        await using var provider = CreateServices(new Dictionary<string, string?>
        {
            ["Realtime:EndpointPath"] = "/socket",
            ["Realtime:TicketEndpointPath"] = "/tickets",
            ["Realtime:AllowedOrigins:0"] = "https://app.example",
            ["Redis:Endpoint"] = "redis.example:6379",
        }).BuildServiceProvider();

        var options = provider.GetRequiredService<RealtimeOptions>();

        Assert.Equal("/socket", options.EndpointPath);
        Assert.Equal("/tickets", options.TicketEndpointPath);
        Assert.IsType<RealtimeSessionResolver>(provider.GetRequiredService<IRealtimeSessionResolver>());
        Assert.NotNull(provider.GetRequiredService<RealtimeWebSocketHandler>());
    }

    [Theory]
    [InlineData("Realtime:EndpointPath", "relative")]
    [InlineData("Realtime:EndpointPath", "/socket?query=true")]
    [InlineData("Realtime:EndpointPath", "/{broken")]
    [InlineData("Realtime:AllowedOrigins:0", "https://app.example/path")]
    [InlineData("Realtime:AllowedOrigins:0", "ftp://app.example")]
    public void AddRealtimeGatewayRejectsInvalidRoutesAndOrigins(string key, string value)
    {
        var values = ValidConfiguration();
        values[key] = value;
        using var provider = CreateServices(values).BuildServiceProvider();

        var exception = Assert.Throws<OptionsValidationException>(
            () => provider.GetRequiredService<IOptions<RealtimeOptions>>().Value);

        Assert.NotEmpty(exception.Failures);
    }

    [Fact]
    public void AddRealtimeGatewayDoesNotDuplicateHostedInfrastructure()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(ValidConfiguration()).Build();
        var services = new ServiceCollection();

        services.AddRealtimeGateway(configuration);
        services.AddRealtimeGateway(configuration);

        Assert.Equal(6, services.Count(descriptor => descriptor.ServiceType == typeof(IHostedService)));
    }

    [Fact]
    public async Task CookieSessionResolutionUsesExistingSessionContractAndRejectsRevocation()
    {
        var store = new FakeSessionStore();
        var resolver = new RealtimeSessionResolver(store, new RealtimeOptions());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = "cormier_session=valid-session-123456";

        var resolution = await resolver.ResolveAsync(context, CancellationToken.None);

        Assert.Equal("tenant-1", resolution?.Identity.TenantId);
        Assert.Equal("user-1", resolution?.Identity.UserId);
        store.Revoked = true;
        Assert.Null(await resolver.RevalidateAsync("valid-session-123456", CancellationToken.None));
    }

    [Fact]
    public async Task AspNetCoreSessionResolutionUsesConfiguredSessionValueAcrossInstances()
    {
        var store = new FakeSessionStore();
        var options = new RealtimeOptions
        {
            SessionSource = RealtimeSessionSource.AspNetCoreSession,
            AspNetCoreSessionIdKey = "realtime-id",
        };
        var firstResolver = new RealtimeSessionResolver(store, options);
        var secondResolver = new RealtimeSessionResolver(store, options);
        var context = new DefaultHttpContext();
        var session = new FakeSession("aspnet-session-id");
        session.SetString("realtime-id", "valid-session-123456");
        context.Features.Set<ISessionFeature>(new SessionFeature { Session = session });

        var first = await firstResolver.ResolveAsync(context, CancellationToken.None);
        var second = await secondResolver.ResolveAsync(context, CancellationToken.None);

        Assert.Equal("valid-session-123456", first?.SessionId);
        Assert.Equal(first?.SessionId, second?.SessionId);
        Assert.Equal(first?.Identity.TenantId, second?.Identity.TenantId);
        Assert.Equal(first?.Identity.UserId, second?.Identity.UserId);
        Assert.Equal(2, store.ValidationCount);
    }

    [Fact]
    public async Task AspNetCoreSessionResolutionExplainsRequiredMiddlewareOrder()
    {
        var resolver = new RealtimeSessionResolver(new FakeSessionStore(), new RealtimeOptions
        {
            SessionSource = RealtimeSessionSource.AspNetCoreSession,
        });

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await resolver.ResolveAsync(new DefaultHttpContext(), CancellationToken.None));

        Assert.Contains("AddSession and UseSession", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExpiredOrUnknownSessionIsRejected()
    {
        var resolver = new RealtimeSessionResolver(new FakeSessionStore { Expired = true }, new RealtimeOptions());
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = "cormier_session=valid-session-123456";

        Assert.Null(await resolver.ResolveAsync(context, CancellationToken.None));
    }

    [Fact]
    public async Task MapRealtimeGatewayRejectsDuplicateRegistrationAndAppliesAuthorizationPolicy()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(ValidConfiguration());
        builder.Services.AddRealtimeGateway(builder.Configuration, options => options.AuthorizationPolicy = "realtime-user");
        await using var app = builder.Build();

        app.MapRealtimeGateway();

        var endpoints = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .ToArray();
        Assert.Equal(2, endpoints.Count(endpoint => endpoint.RoutePattern.RawText is "/realtime/ws" or "/realtime/tickets"));
        Assert.All(endpoints.Where(endpoint => endpoint.RoutePattern.RawText is "/realtime/ws" or "/realtime/tickets"), endpoint =>
            Assert.Contains(endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>(), metadata => metadata.Policy == "realtime-user"));
        Assert.Throws<InvalidOperationException>(() => app.MapRealtimeGateway());
    }

    [Fact]
    public async Task MapRealtimeGatewayRejectsAConflictingApplicationRoute()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(ValidConfiguration());
        builder.Services.AddRealtimeGateway(builder.Configuration);
        await using var app = builder.Build();
        app.MapGet("/realtime/ws", () => "application endpoint");

        var exception = Assert.Throws<InvalidOperationException>(() => app.MapRealtimeGateway());

        Assert.Contains("already mapped", exception.Message, StringComparison.Ordinal);
    }

    private static ServiceCollection CreateServices(IDictionary<string, string?> values)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddRealtimeGateway(configuration);
        return services;
    }

    private static Dictionary<string, string?> ValidConfiguration() => new()
    {
        ["Realtime:EndpointPath"] = "/realtime/ws",
        ["Realtime:TicketEndpointPath"] = "/realtime/tickets",
        ["Realtime:AllowedOrigins:0"] = "https://app.example",
        ["Redis:Endpoint"] = "redis.example:6379",
    };

    private sealed class FakeSessionStore : IRealtimeSessionStore
    {
        public bool Revoked { get; set; }

        public bool Expired { get; set; }

        public int ValidationCount { get; private set; }

        public ValueTask<RealtimeIdentity?> ValidateAsync(string sessionId, CancellationToken cancellationToken)
        {
            ValidationCount++;
            var valid = sessionId == "valid-session-123456" && !Revoked && !Expired;
            return ValueTask.FromResult<RealtimeIdentity?>(valid
                ? new RealtimeIdentity("tenant-1", "user-1", ["orders"], DateTimeOffset.UtcNow.AddMinutes(5))
                : null);
        }
    }

    private sealed class SessionFeature : ISessionFeature
    {
        public required ISession Session { get; set; }
    }

    private sealed class FakeSession(string id) : ISession
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public bool IsAvailable => true;

        public string Id { get; } = id;

        public IEnumerable<string> Keys => _values.Keys;

        public void Clear() => _values.Clear();

        public Task CommitAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task LoadAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public void Remove(string key) => _values.Remove(key);

        public void Set(string key, byte[] value) => _values[key] = value;

        public bool TryGetValue(string key, out byte[] value) => _values.TryGetValue(key, out value!);
    }
}
