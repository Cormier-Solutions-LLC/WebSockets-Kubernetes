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
        await WaitUntilReadyAsync(client);

        var stopping = factory.Host.StopAsync();
        using var drainingResponse = await client.GetAsync("/health/ready", CancellationToken.None);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, drainingResponse.StatusCode);
        await stopping;
    }

    private static async Task WaitUntilReadyAsync(HttpClient client)
    {
        for (var attempt = 0; attempt < 30; attempt++)
        {
            using var response = await client.GetAsync("/health/ready", CancellationToken.None);
            if (response.StatusCode == HttpStatusCode.OK)
            {
                return;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100));
        }

        Assert.Fail("Gateway did not become ready within the bounded startup wait.");
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
