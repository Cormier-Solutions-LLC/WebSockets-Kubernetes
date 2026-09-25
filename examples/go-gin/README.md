# Go and Gin reference application

This non-production adapter demonstrates a Gin front end for Cormier.Realtime. Explicit application state holds typed configuration, a Redis session store, and a bounded HTTP client. It forwards tickets and WebSockets while preserving Host, Origin, cookies, query parameters, and the subprotocol, and serves the canonical SDK and UI without copies. `LISTEN_HOST` and `PORT` select the listener explicitly.

## Prerequisites and local run

- Go 1.27.1
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`
- Node.js 22 or later and npm to regenerate the canonical SDK and shared UI assets. From the repository root, run `npm --prefix sdk/typescript ci` followed by `npm --prefix sdk/typescript run build`. This produces both `sdk/typescript/dist` and `examples/shared-web/dist` required by the container.

For ticket and WebSocket relays, the adapter forwards the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single forwarding hop; never trust public or broader ranges.

Supply every `.env.example` value externally; the application does not load the fixture. From `examples/go-gin`, run `go run -mod=readonly .`. Run the repeatable gate with:

Set `HEARTBEAT_INTERVAL_MILLISECONDS` to the gateway's configured `Realtime:HeartbeatSeconds` multiplied by 1000. The adapter publishes this value through `/api/diagnostics` so the shared browser client uses the same heartbeat cadence.

```text
gofmt -l *.go
go test -mod=readonly ./...
go vet -mod=readonly ./...
```

Build and run the digest-pinned multi-stage container from the repository root:

```text
docker build -f examples/go-gin/Dockerfile -t cormier-go-gin:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/go-gin/.env.example --env GATEWAY_URL=http://host.docker.internal:15501 --env REDIS_URL=redis://host.docker.internal:16379 cormier-go-gin:local
```

Configuration fails before binding on unsafe origins, Redis schemes, identifiers, topology, TTL, ports, or allowlists. Redis operations use five-second contexts and outbound ticket requests use a 15-second HTTP timeout; WebSocket dialing has a 15-second deadline. Established relays have no per-message deadline. Both relay directions enforce a 64 KiB message limit, so keep the gateway limit compatible. Login/ticket request bodies and ticket responses are limited to 64 KiB. SIGINT/SIGTERM initiates graceful shutdown with a shared 15-second deadline for HTTP and WebSockets. Logs contain structural event names and omit dependency error text and configured endpoints.

`/health` returns 200 when Redis responds and 503 otherwise; it does not probe the gateway. `/api/diagnostics` reports Redis state, instance, and topology. `TOPOLOGY` labels diagnostics; it does not provision replicas or Redis high availability. Local runs use `../shared-web/wwwroot` and `../../sdk/typescript/dist` relative to the example directory. Containers use the generated optimized UI; set `SHARED_ASSET_ROOT=/app/shared-web/readable` for the readable rollback profile.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Allowlisted identities; gateway-compatible record in Redis |
| Ticket and WebSocket forwarding | Available | Host, Origin, cookie, query, and subprotocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK and shared UI |
| Expiry/rejected Origin/gateway outage | Available | Adapter checks, bounded generic failures, gateway policy |
| Health and diagnostics | Available | Redis-aware and redacted |
| Relay cancellation | Available | Both directions stop when either WebSocket ends |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Repository pin / compatibility | Status |
| --- | --- | --- |
| Go | 1.27.1 | `go.mod` and Dockerfile pin |
| Gin | 1.12.0 | `go.mod` pin |
| go-redis | 9.21.0 | `go.mod` pin |
| coder/websocket | 1.8.15 | `go.mod` pin |
| Go module graph | `go.mod` and `go.sum` | Read-only, reproducible resolution |
| Cormier.Realtime SDK / protocol / gateway | 1.0.3-beta / 1.0 / 1.0.3-beta | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |
| Container bases | Go 1.27.1 Alpine / Alpine 3.24 | Digest-pinned |

The adapter has four stack-specific Go files and 849 nonblank lines, including tests. Shared assets, fixtures, generated SDK, module/build metadata, and docs are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Go/Gin/module, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
