# Go and Gin reference application

This non-production adapter demonstrates a Gin front end for Cormier.Realtime. Explicit application state holds typed configuration, a Redis session store, and a bounded HTTP client. It forwards tickets and WebSockets while preserving Host, Origin, cookies, query parameters, and the subprotocol, and serves the canonical SDK and UI without copies. `LISTEN_HOST` and `PORT` select the listener explicitly.

## Prerequisites and local run

- Go 1.27.1
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`

For ticket and WebSocket relays, the adapter forwards the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single forwarding hop; never trust public or broader ranges.
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally; the application does not load the fixture. From `examples/go-gin`, run `go run -mod=readonly .`. Run the repeatable gate with:

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

Configuration fails before binding on unsafe origins, Redis schemes, identifiers, topology, TTL, ports, or allowlists. Redis, HTTP, and WebSocket operations have 5–15 second bounds. Both WebSocket relay directions use the gateway's 64 KiB message boundary; HTTP headers and bodies are also bounded. SIGINT/SIGTERM initiates graceful shutdown with a 15-second deadline. Logs contain structural event names and never dependency error text or configured endpoints.

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

| Component | Tested version | Status |
| --- | --- | --- |
| Go | 1.27.1 | Pinned supported stable point release |
| Gin | 1.12.0 | Supported framework |
| go-redis | 9.21.0 | Supported session client |
| coder/websocket | 1.8.15 | Supported WebSocket implementation |
| Go module graph | `go.mod` and `go.sum` | Read-only, reproducible resolution |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |
| Container bases | Go 1.27.1 Alpine / Alpine 3.24 | Digest-pinned |

The adapter has four stack-specific Go files and 635 nonblank lines, including tests. Shared assets, fixtures, generated SDK, module/build metadata, and docs are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Go/Gin/module, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
