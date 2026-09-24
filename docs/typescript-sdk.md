# TypeScript and browser SDK

## Artifacts and API

The independent `@cormier/realtime` project lives in `sdk/typescript`. Its build emits the following deterministic files under `dist`:

| Consumption | Readable | Minified | Export |
|---|---|---|---|
| ECMAScript module | `cormier-realtime.js` | `cormier-realtime.min.js` | named exports |
| Direct browser script | `cormier-realtime.iife.js` | `cormier-realtime.iife.min.js` | `window.CormierRealtime` |

Each JavaScript file has a source map. The package also includes TypeScript declarations, declaration maps, and `version.json`. Minified output is limited to 32 KiB before compression and 12 KiB with deterministic gzip. Artifact verification rejects absolute source-machine paths and known credential-bearing strings.

The same build creates centralized readable and optimized assets for every reference web stack. Production examples select the optimized profile, while development and support retain a readable profile. Optional deterministic obfuscation requires an explicit command and is not a security control. The [optimized-assets guide](optimized-assets.md) documents manifests, hashes, SRI, CSP, coordinated selectors, source-map publication, accessibility verification, migration, and rollback.

`RealtimeClient` exposes `connect`, `disconnect`, `publish`, `subscribe`, `ping`, state/close/error/event listeners, and the desired-subscription snapshot. Commands resolve only after a correlated acknowledgement and reject with a structured `RealtimeError` when the gateway sends an error. Queue and pending-command limits are finite and configurable; oversized commands are rejected before transport.

`DiagnosticsClient` is a separate operator client for the versioned diagnostics API. It exposes `snapshot`, `activeLogLevels`, paginated `audit`, `applyLogLevel`, `revertLogLevel`, `streamEvents`, and `tailLogs`. Configure its `baseUrl` and authorization headers explicitly; streaming requests use credentialed `fetch`, retry ordinary interruptions, and stop when the server emits a bounded `disconnect` event. Never embed an operator token in a public browser bundle or persist one in browser storage. Server-side authorization, Origin, network, redaction, rate, and duration controls remain authoritative.

## Authentication and browser security

Session mode relies on the gateway's configured same-origin HttpOnly cookie. JavaScript neither reads nor copies the cookie. Ticket mode POSTs to the configurable ticket endpoint with same-origin credentials before every connection and reconnect. It validates the response and puts the short-lived ticket only in the WebSocket handshake query. Ticket values are not exposed to SDK callbacks, error messages, or logs.

Applications must use HTTPS/WSS outside loopback development. Edge access logs must redact the `ticket` query parameter. Allowed Origins, endpoint paths, hosts, and ports are deployment configuration; the SDK contains none. A page can use an external ESM or IIFE artifact with `script-src 'self'` and `connect-src` limited to the configured HTTPS/WSS origin. The SDK uses no `eval`, dynamic code generation, or inline-script requirement.

## Connection lifecycle

The client sends protocol heartbeat commands on a bounded interval. Unexpected disconnects use capped exponential backoff, bounded jitter, and a finite attempt limit. `service.restart` advice overrides the delay bounds for the affected reconnect. Ticket mode obtains a new single-use ticket for every attempt; session mode lets the new gateway replica revalidate the Redis-backed session.

Desired routes are stored as a set. Multiple local listeners share one gateway subscription, and a reconnect restores each intended route once. Commands whose outcome became unknown when a connection closed are rejected rather than replayed, preventing accidental duplicate publishes. Pub/Sub remains ephemeral: events missed during a disconnect are not replayed. Redis Streams are a distinct, explicitly approved durable path.

No sticky session or load-balancer affinity is required. The browser matrix includes a round-robin test proxy with two gateway processes sharing Redis. It drops the first connection, verifies the next connection reaches the other replica with a fresh ticket, restores one subscription, and observes exactly one matching event. The same suite proves tenant isolation across replicas. A WAF or load balancer needs only standard WebSocket Upgrade forwarding, a timeout longer than the heartbeat interval, TLS termination or pass-through as deployed, and query-string redaction; it needs no application-specific plugin.

## Supported browsers

The compatibility floor is ES2022 in maintained evergreen browsers. CI uses the exact engines pinned by Playwright:

| Family | CI engine for SDK 1.0.1-beta | Consumption tested |
|---|---:|---|
| Chromium (Chrome and Edge lineage) | 153 | readable/minified ESM and IIFE |
| Firefox | 155 | readable/minified ESM and IIFE |
| WebKit (Safari lineage) | 26.6 | readable/minified ESM and IIFE |

The matrix tests authorized ticket connections, publish/subscription exchange, rejected Origin, expired and reused tickets, cross-replica reconnect, Redis fan-out, and tenant isolation. Unit tests additionally cover ticket-service interruption/recovery, malformed server traffic, message limits, cancellation, bounded queues, structured errors, heartbeats, and duplicate-free subscription restoration.

## Compatibility and upgrades

SDK `0.1.x` implements wire protocol `1.0` and subprotocol `cormier.realtime.v1`. Additive optional server fields are compatible and ignored unless recognized. Removing or changing a required field, message semantic, stable error code, or subprotocol is breaking and requires a new protocol plus an SDK major release. Shared golden fixtures are verified by TypeScript and .NET tests.

During a rolling upgrade, retain protocol `1.0` on every gateway until all browser assets and caches have moved to a compatible version. Deploy readable or minified artifacts from the same build; do not mix source maps or declarations across versions. Roll back by restoring the previous immutable asset set and gateway version together. Browser cache invalidation should use the package version or content hash.

## Build and verification

Node.js 22 or later, the repository's pinned .NET SDK, Redis 7.4, and current Playwright browser engines are required for the full local suite:

```powershell
dotnet build .\Cormier.Realtime.sln --configuration Release
Push-Location .\sdk\typescript
npm ci
npm run check
npx playwright install chromium firefox webkit
npm run test:browser
npm pack --dry-run
Pop-Location
```

Set `REDIS_TEST_ENDPOINT` when Redis is not reachable at `127.0.0.1:6379`. Browser gateway, proxy, and static-server ports are configurable with `REALTIME_BROWSER_GATEWAY_PORT`, `REALTIME_BROWSER_SECOND_GATEWAY_PORT`, `REALTIME_BROWSER_PROXY_PORT`, and `REALTIME_BROWSER_STATIC_PORT`.

For troubleshooting, observe the SDK state transition and stable error/close code. `ticket_rejected` indicates the ticket POST failed; `connection_failed` identifies handshake or transport failure; `command_timeout` means no correlated response arrived; `queue_saturated` means a configured bound was reached. Never add cookie, ticket, payload, tenant, user, or full WebSocket URL values to diagnostic output.
