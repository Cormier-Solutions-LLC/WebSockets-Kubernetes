# Cormier.Realtime.Client

`Cormier.Realtime.Client` is the runtime-neutral .NET Standard 2.0 client for the Cormier.Realtime WebSocket protocol. It has no ASP.NET Core hosting dependency and can be consumed by .NET 8, .NET 10, and other runtimes that implement .NET Standard 2.0 and support the package dependency graph.

Install from your approved NuGet source with `dotnet add package Cormier.Realtime.Client --version 1.0.1-beta`. The following example assumes application-owned `configuration`, `cancellationToken`, and `ApplicationAuthenticationProvider`; that provider is not a package type. It must acquire valid session/ticket material and supply the Origin/header configuration required by the target gateway.

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
// Inspect message.Type and CorrelationId: this may be an ack, error or event.
await client.DisconnectAsync(cancellationToken);
```

Implement `IRealtimeAuthenticationProvider` to return a fresh connection ticket, Cookie header, or application header set for every connection attempt. `RealtimeAuthenticationMaterial.ToString()` is always redacted, and the client emits only fixed diagnostic messages through `IRealtimeClientLogger`.

The interface method is `Task<RealtimeAuthenticationMaterial> GetAuthenticationAsync(CancellationToken)`. Return `new RealtimeAuthenticationMaterial(connectionTicket: ticket, headers: headers)` for ticket mode, or use `cookieHeader` for the gateway's configured session cookie. Include the allowed `Origin` in `headers` when required. The default anonymous provider does not bypass gateway authentication. The library does not POST to the ticket endpoint for you; acquisition and renewal belong to the provider. `Endpoint` must be an absolute `ws`/`wss` URI and must not contain `ticket` or the reserved `reconnect` query parameter.

Credentialed connections require `wss://` for non-loopback endpoints. Local loopback development may use `ws://`; `AllowInsecureCredentialTransport` is an explicit opt-in for exceptional test environments and must not be enabled in production.

The send and receive queues, message sizes, subscriptions, heartbeats, reconnect attempts, jitter, and transport close wait are bounded. Existing subscriptions are restored once after reconnection. Subscription changes are accepted only while connected, which avoids ambiguous offline ordering. Ordinary retries use configurable bounded jitter to avoid reconnect waves; service-restart guidance from the gateway overrides the local delay and jitter settings. Authentication material is refreshed on every connection attempt.

`PublishAsync`/`SendAsync` enqueue validated messages; completion is not a correlated server acknowledgement or durable-delivery guarantee. Continuously consume `ReceiveAsync` and inspect envelope type/correlation, including subscription acknowledgements and errors. Automatic heartbeat acknowledgements are handled internally. Bounded queues apply backpressure, so pass cancellation tokens and keep the receive loop moving. Use `SubscribeAsync`/`UnsubscribeAsync` for subscription changes rather than raw `SendAsync` envelopes.

Defaults are 128 send and receive slots, 64 subscriptions, a 16 KiB frame limit, a 64 KiB message limit, 15-second heartbeats, eight reconnect attempts, 250 ms initial retry delay, 30-second maximum delay, 20% jitter and a five-second close timeout. The default transport accepts text, unfragmented messages only; the frame limit is therefore relevant even when the configured message limit is larger. Options are validated and copied at construction, so later mutation of the original options object does not reconfigure the client.

`IRealtimeTransportFactory`, `IRealtimeClientClock`, `IRealtimeRetryPolicy`, `IRealtimeRandom`, and `IRealtimeClientLogger` are replaceable for platform integration and deterministic tests. The default transport uses `ClientWebSocket` and the `cormier.realtime.v1` subprotocol. A completed or faulted client is not restartable; create a new instance after an explicit disconnect or terminal close.

The package ships XML documentation, symbols with Source Link metadata, a README, and a dependency on the compatible `Cormier.Realtime.Contracts` `0.1.x` line. Its runtime support dependencies are constrained to the compatible `10.x` line. Routes, hosts, headers, cookies, and tickets are supplied at runtime and are never compiled into the package.

Current package metadata constrains System.Text.Json and System.Threading.Channels to `[10.0.12,11.0.0)`; default Contracts packaging uses `[1.0.0,1.1.0)`. The default subprotocol and queue/size defaults are compiled behavior defaults, while deployment endpoints and credentials are runtime inputs. Repository validation includes client unit tests and `scripts/Test-DotNetClientPackage.ps1` for package contents and an isolated consumer. See the [protocol contract](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/protocol.md) and [release policy](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/package-release.md).
