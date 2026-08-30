using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Hosting;

namespace Propago.Realtime.IntegrationTests;

public sealed class ShutdownDrainTests
{
    [Fact]
    public async Task ReadinessRemainsReachableAndUnavailableDuringDrain()
    {
        await using var factory = new CapturingWebApplicationFactory();
        using var client = factory.CreateClient();
        using var initialResponse = await client.GetAsync("/health/ready", CancellationToken.None);
        Assert.Equal(HttpStatusCode.OK, initialResponse.StatusCode);

        var stopping = factory.Host.StopAsync();
        using var drainingResponse = await client.GetAsync("/health/ready", CancellationToken.None);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, drainingResponse.StatusCode);
        await stopping;
    }

    private sealed class CapturingWebApplicationFactory : WebApplicationFactory<Program>
    {
        public IHost Host { get; private set; } = null!;

        protected override IHost CreateHost(IHostBuilder builder)
        {
            Host = base.CreateHost(builder);
            return Host;
        }
    }
}
