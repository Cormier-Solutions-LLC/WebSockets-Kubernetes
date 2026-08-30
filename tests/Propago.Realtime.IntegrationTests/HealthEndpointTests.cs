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

    [Theory]
    [InlineData("/health/startup")]
    [InlineData("/health/live")]
    [InlineData("/health/ready")]
    public async Task HealthEndpointReturnsHealthy(string path)
    {
        using var response = await _client.GetAsync(path, CancellationToken.None);
        var body = await response.Content.ReadFromJsonAsync(
            RealtimeJsonSerializerContext.Default.HealthStatusResponse,
            CancellationToken.None);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(body);
        Assert.Equal("healthy", body.Status);
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
