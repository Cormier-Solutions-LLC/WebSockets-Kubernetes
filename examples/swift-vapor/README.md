# Swift Vapor reference application

This non-production adapter demonstrates a compact Vapor front end for Cormier.Realtime. Vapor provides strict configuration, an opaque cookie backed by a gateway-compatible Redis session, ticket forwarding, health/diagnostics, and canonical asset delivery. Caddy relays only the raw WebSocket route. Shared HTML, CSS, generated JavaScript, schema, fixtures, and browser tests remain external sources of truth.

## Prerequisites and local run

- Swift 6.3.3
- Vapor 4.121.4 and Vapor Redis 4.14.0 from `Package.resolved`
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway sharing the configured prefixes and trusted `PUBLIC_ORIGIN`
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally and adjust all network values for the target environment; the application does not load the fixture. From this directory run this repeatable gate:

```text
swift package resolve --disable-sandbox
git diff --exit-code Package.resolved
swift format lint --recursive --strict Sources Tests Package.swift
swift test --disable-sandbox
```

Build and run the digest-pinned container from the repository root:

```text
docker build -f examples/swift-vapor/Dockerfile -t cormier-swift-vapor:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/swift-vapor/.env.example -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:16379 cormier-swift-vapor:local
```

Configuration, Redis, and canonical assets are checked before the public listener is considered ready. Vapor binds only to the configured private application listener; Caddy exposes the configured public `LISTEN_HOST` and port. The ticket and WebSocket relays forward browser authority and the scheme derived from validated `PUBLIC_ORIGIN`; configure the gateway to trust only the adapter network. Redis commands have five-second response deadlines. Logs contain structural lifecycle/failure events and error types only. Tini supervises graceful shutdown, and the image runs as numeric user/group 65532.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Opaque HttpOnly Strict cookie plus allowlisted gateway-compatible Redis record |
| Ticket and WebSocket forwarding | Available | Browser authority, Origin, cookie, and protocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK, protocol, UI, and shared smoke suite |
| Expiry/rejected Origin/gateway outage | Available | Session TTL/revalidation, strict Origin, bounded generic failures |
| Health and diagnostics | Available | Redis-aware and redacted |
| Startup/shutdown | Available | Pre-bind validation and supervised Vapor/Caddy termination |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Swift | 6.3.3 | Exact build/runtime image pin |
| Vapor / Vapor Redis | 4.121.4 / 4.14.0 | Exact direct dependency pins |
| Swift dependency graph | `Package.resolved` | Fully resolved transitive graph; locked-resolution and tests required |
| Caddy | 2.11.4 | Digest-pinned WebSocket edge |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |

The adapter has 5 stack-specific Swift source/test files and 590 nonblank lines. SwiftPM build outputs, shared assets/fixtures, lock/build metadata, browser harness configuration, and documentation are excluded. Recalculate after changes.

## Platform support

The supported deployment target is the supplied Linux container on the pinned Ubuntu 24.04 Swift images. macOS 15 or later is supported for local SwiftPM development. Windows hosts are supported through the Linux container workflow; a native Windows Vapor deployment is not claimed by this example.

## Support

Open a repository issue for non-sensitive defects with Swift, Vapor, Vapor Redis, resolved graph, SDK/protocol/gateway, Redis, Caddy, and container versions; platform; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the repository security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
