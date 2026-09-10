using System.Text.Json;
using Cormier.Realtime.Client;
using Cormier.Realtime.Contracts;

var configuredEndpoint = Environment.GetEnvironmentVariable("REALTIME_ENDPOINT");
if (!Uri.TryCreate(configuredEndpoint, UriKind.Absolute, out var endpoint)
    || endpoint.Scheme is not ("ws" or "wss"))
{
    Console.WriteLine("Set REALTIME_ENDPOINT to a ws:// or wss:// gateway endpoint.");
    return;
}

using var stopping = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    stopping.Cancel();
};

using var client = new RealtimeClient(
    new RealtimeClientOptions { Endpoint = endpoint },
    new EnvironmentAuthenticationProvider());
try
{
    await client.ConnectAsync(stopping.Token);

    var orders = RealtimeRoute.ForTopic("orders");
    await client.SubscribeAsync(orders, cancellationToken: stopping.Token);
    await client.PublishAsync(
        orders,
        JsonSerializer.SerializeToElement(new { source = "dotnet-client-example" }),
        cancellationToken: stopping.Token);

    while (!stopping.IsCancellationRequested)
    {
        var message = await client.ReceiveAsync(stopping.Token);
        Console.WriteLine($"Received {message.Type} for {message.Route}.");
    }
}
catch (OperationCanceledException) when (stopping.IsCancellationRequested)
{
    // Ctrl+C requests a cooperative, successful shutdown.
}

internal sealed class EnvironmentAuthenticationProvider : IRealtimeAuthenticationProvider
{
    public Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var origin = Environment.GetEnvironmentVariable("REALTIME_ORIGIN");
        if (!string.IsNullOrWhiteSpace(origin))
        {
            headers["Origin"] = origin;
        }
        return Task.FromResult(new RealtimeAuthenticationMaterial(
            connectionTicket: Environment.GetEnvironmentVariable("REALTIME_TICKET"),
            cookieHeader: Environment.GetEnvironmentVariable("REALTIME_COOKIE"),
            headers: headers));
    }
}
