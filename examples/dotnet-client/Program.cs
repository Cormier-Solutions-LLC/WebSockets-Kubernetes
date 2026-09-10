using System.Text.Json;
using Cormier.Realtime.Client;
using Cormier.Realtime.Contracts;

var configuredEndpoint = Environment.GetEnvironmentVariable("REALTIME_ENDPOINT");
if (!Uri.TryCreate(configuredEndpoint, UriKind.Absolute, out var endpoint))
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

internal sealed class EnvironmentAuthenticationProvider : IRealtimeAuthenticationProvider
{
    public Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new RealtimeAuthenticationMaterial(
            connectionTicket: Environment.GetEnvironmentVariable("REALTIME_TICKET"),
            cookieHeader: Environment.GetEnvironmentVariable("REALTIME_COOKIE")));
}
