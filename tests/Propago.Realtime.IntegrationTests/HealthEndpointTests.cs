using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Propago.Realtime.Contracts;

namespace Propago.Realtime.IntegrationTests;

public sealed class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public HealthEndpointTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task LivenessEndpointReturnsHealthy()
    {
        using var response = await _client.GetAsync("/health/live", CancellationToken.None);
        var body = await response.Content.ReadFromJsonAsync(
            RealtimeJsonSerializerContext.Default.HealthStatusResponse,
            CancellationToken.None);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal("healthy", body.Status);
    }

    [Theory]
    [InlineData("/health/startup", "starting")]
    [InlineData("/health/ready", "unavailable")]
    public async Task StateDependentHealthEndpointsExposeValidState(
        string path,
        string transitionalStatus)
    {
        using var response = await _client.GetAsync(path, CancellationToken.None);
        var body = await response.Content.ReadFromJsonAsync(
            RealtimeJsonSerializerContext.Default.HealthStatusResponse,
            CancellationToken.None);

        Assert.Contains(
            response.StatusCode,
            new[] { HttpStatusCode.OK, HttpStatusCode.ServiceUnavailable });
        Assert.NotNull(body);
        Assert.Contains(body.Status, new[] { "healthy", transitionalStatus });
        Assert.Equal(
            response.StatusCode == HttpStatusCode.OK,
            body.Status == "healthy");
    }

    [Fact]
    public async Task MetricsEndpointUsesPrometheusTextFormat()
    {
        using var response = await _client.GetAsync("/metrics", CancellationToken.None);
        var body = await response.Content.ReadAsStringAsync(CancellationToken.None);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("propago_realtime_health_requests_total", body, StringComparison.Ordinal);
    }
}
