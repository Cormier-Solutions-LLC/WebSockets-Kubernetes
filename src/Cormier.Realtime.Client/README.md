# Cormier.Realtime.Client

`Cormier.Realtime.Client` is the runtime-neutral .NET Standard 2.0 client for the Cormier.Realtime WebSocket protocol. It has no ASP.NET Core hosting dependency and can be consumed by .NET 8, .NET 10, and other runtimes that implement .NET Standard 2.0 and support the package dependency graph.

```csharp
using System.Text.Json;
using Cormier.Realtime.Client;

var options = new RealtimeClientOptions
{
    Endpoint = new Uri(configuration.RealtimeWebSocketUri),
};
using var client = new RealtimeClient(
    options,
    authenticationProvider: new ApplicationAuthenticationProvider());

await client.ConnectAsync(cancellationToken);
await client.SubscribeAsync("topics/orders", cancellationToken: cancellationToken);
await client.PublishAsync(
    "topics/orders",
    JsonSerializer.SerializeToElement(new { orderId = "example-order" }),
    cancellationToken: cancellationToken);
var message = await client.ReceiveAsync(cancellationToken);
```

Implement `IRealtimeAuthenticationProvider` to return a fresh connection ticket, Cookie header, or application header set for every connection attempt. `RealtimeAuthenticationMaterial.ToString()` is always redacted, and the client emits only fixed diagnostic messages through `IRealtimeClientLogger`.

The send and receive queues, message sizes, subscriptions, heartbeats, reconnect attempts, and transport close wait are bounded. Existing subscriptions are restored once after reconnection. Subscription changes are accepted only while connected, which avoids ambiguous offline ordering. Service-restart guidance from the gateway supplies a deterministic bounded reconnect delay; authentication material is refreshed on every connection attempt.

`IRealtimeTransportFactory`, `IRealtimeClientClock`, `IRealtimeRetryPolicy`, `IRealtimeRandom`, and `IRealtimeClientLogger` are replaceable for platform integration and deterministic tests. The default transport uses `ClientWebSocket` and the `cormier.realtime.v1` subprotocol. A completed or faulted client is not restartable; create a new instance after an explicit disconnect or terminal close.

The package ships XML documentation, symbols with Source Link metadata, a README, and a dependency on the compatible `Cormier.Realtime.Contracts` `0.1.x` line. Its runtime support dependencies are constrained to the compatible `10.x` line. Routes, hosts, headers, cookies, and tickets are supplied at runtime and are never compiled into the package.
