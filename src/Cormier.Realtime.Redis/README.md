# Cormier.Realtime.Redis

Redis-backed Pub/Sub, durable Streams, session validation, and connection-ticket infrastructure for Cormier.Realtime hosts.

Install this package directly only when composing the lower-level Redis services. Most ASP.NET Core applications should install `Cormier.Realtime.AspNetCore`, which carries the compatible Redis and Contracts dependencies.

Redis endpoints, credentials, key prefixes, and deployment identities are configuration and are never embedded in this package.

The package targets `net10.0`, depends on StackExchange.Redis `3.1.31`, and carries a compatible Contracts dependency (default range `[1.0.0,1.1.0)`). Install from your configured NuGet source with `dotnet add package Cormier.Realtime.Redis --version 1.0.3-beta`. It does not provision Redis, configure ACLs, register gateway endpoints or supply a login flow.

## Composition and configuration

The ASP.NET Core package's `AddRealtimeGateway` binds and validates `RedisOptions` and registers the provider/stores. A lower-level host must supply and validate options, own the `RedisConnectionProvider` lifetime, and dispose it asynchronously. `GetConnectionAsync` lazily shares one multiplexer; `CurrentConnection` is null before creation. For example, with application-owned configuration and cancellation:

```csharp
using Cormier.Realtime.Redis;

var options = new RedisOptions
{
    Endpoint = configuration.RedisEndpoint,
    InstancePrefix = configuration.RedisInstancePrefix,
};
await using var connections = new RedisConnectionProvider(options);
var sessions = new RedisSessionStore(connections, options);
var identity = await sessions.ValidateAsync(sessionId, cancellationToken);
```

Supply `User`/`Password` together from runtime secret configuration when required. `Ssl` selects direct TLS; Sentinel uses `SentinelServiceName` and `SentinelPassword`. The hosting validator rejects combining Sentinel discovery with direct TLS. Set a deployment-specific `InstancePrefix`; its built-in `cormier:realtime` default is not an isolation plan. Defaults include three connection retries and a 5,000 ms connect timeout. Cancellation is checked at entry and while acquiring the connection lock; it does not cancel every underlying Redis operation. `IsReadyAsync` returns true for a successful PING taking at most two seconds, not a two-second timeout imposed on that command.

## Service contracts

| API | Behavior |
| --- | --- |
| `IRealtimeSessionStore` / `RedisSessionStore` | Reads `<InstancePrefix>:<SessionKeyPrefix>:<sessionId>` and validates record shape, identity/topic scopes, expiration and revocation; it does not create sessions |
| `IConnectionTicketStore` / `RedisConnectionTicketStore` | Issues cryptographically random URL-safe tickets with a TTL capped by identity expiry; consumes through atomic GET/DEL before checking audience/record validity |
| `IRealtimeMessageBus` / `RedisRealtimeMessageBus` | Publishes/subscribes on literal `<InstancePrefix>:<PubSubChannel>`; returns an async-disposable subscription and discards malformed incoming contracts |
| `IDurableRealtimeStore` / `RedisDurableRealtimeStore` | Explicit append, consumer-group read, pending recovery, completion marker and acknowledgement operations for enabled Streams |

The session writer must store camel-case `RedisSessionRecord` JSON with an appropriate Redis TTL. A consumed ticket cannot be reused, even if the attempted audience was wrong. Keep ticket values, cookies and serialized session records out of logs. Pub/Sub is ephemeral: offline subscribers miss messages, and publication is not proof that a browser received or processed an event. Host authorization must still filter tenant, user and topic scope; sharing a Redis channel does not grant client access.

## Optional Streams

`StreamsEnabled` defaults to false; durable APIs throw while disabled. Gateway routing also requires explicitly allowed `Realtime:DurableEventClasses`. Streams use `<InstancePrefix>:<StreamKeyPrefix>:<eventClass>`, with consumer groups created from the beginning. `ReadAsync` reads new group entries; `RecoverPendingAsync` uses auto-claim for entries idle beyond the configured threshold. Consumers must explicitly acknowledge processing. Defaults are approximately 10,000 retained entries, 100 per read, 30,000 ms claim idle time, 86,400 seconds for completion markers and approximately 1,000 poison entries.

`TryMarkCompletedAsync` creates a TTL-bound NX marker; it is not a transaction with application side effects or acknowledgement and does not provide exactly-once processing. Design idempotent consumers and recovery ordering. Invalid stream records are copied to a `:poison` stream and acknowledged; poison records include original data and need appropriate access/retention controls. Approximate trimming and expiring markers do not provide indefinite retention or automatic browser replay.

Repository coverage is in `tests/Cormier.Realtime.IntegrationTests/RedisMessagingTests.cs`, including sessions/tickets, cross-instance messaging and durable-store behavior. Use disposable Redis with explicit test configuration. See the [protocol guide](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/protocol.md), [bootstrap guide](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/bootstrap.md) and [release policy](https://github.com/Cormier-Solutions-LLC/WebSockets-Kubernetes/blob/main/docs/package-release.md).
