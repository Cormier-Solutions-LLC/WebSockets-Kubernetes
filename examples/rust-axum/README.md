# Rust and Axum reference application

This non-production adapter demonstrates an Axum front end for Cormier.Realtime. Explicit application state holds typed configuration, a Redis session store, and a bounded HTTP client. The adapter forwards tickets and WebSockets while preserving Host/Origin/cookies/query parameters, caps browser WebSocket frames and messages at 64 KiB before relay, and serves the canonical SDK and UI without copies. `LISTEN_HOST` and `PORT` select the listener explicitly.

## Prerequisites and local run

- Rust 1.98.1 (pinned by `rust-toolchain.toml`)
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`

For ticket and WebSocket relays, the adapter forwards the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single forwarding hop; never trust public or broader ranges.
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally; the application does not load the fixture. From `examples/rust-axum`, run `cargo run --locked`. Run the repeatable gate with:

```text
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Build/run the digest-pinned container from the repository root:

```text
docker build -f examples/rust-axum/Dockerfile -t cormier-rust-axum:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15400:15400 --env-file examples/rust-axum/.env.example --env GATEWAY_URL=http://host.docker.internal:15401 --env REDIS_URL=redis://host.docker.internal:16379 cormier-rust-axum:local
```

Configuration fails before binding on unsafe origins, Redis schemes, identifiers, topology, TTL, ports, or allowlists. Both `redis://` and CA-verified `rediss://` connections are supported. Redis connect/readiness, HTTP forwarding, and WebSocket connection have 5–15 second bounds. SIGINT/SIGTERM initiates graceful shutdown with a 15-second completion bound. Logs contain structural event names, never error text or configured dependency details.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Allowlisted identities; gateway-compatible record in Redis |
| Ticket and WebSocket forwarding | Available | Host, Origin, cookie, query, and subprotocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK and shared UI |
| Expiry/rejected Origin/gateway outage | Available | Adapter session checks, bounded generic failures, gateway policy |
| Health and diagnostics | Available | Redis-aware and redacted |
| Async cancellation | Available | `tokio::select!` drops the peer relay when either direction ends |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Rust | 1.98.1 | Pinned stable point release/toolchain |
| Axum | 0.8.9 | Supported framework |
| Redis crate | 1.7.0 | Supported async session client |
| Cargo graph | 218 locked packages | `Cargo.lock` required on every build |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |
| Container bases | Rust 1.98.1 Alpine / Alpine 3.24 | Digest-pinned |

The adapter has three stack-specific Rust files and 762 nonblank lines, including tests colocated with typed configuration. Shared assets, fixtures, generated SDK, lock/build metadata, and docs are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Rust/Axum/Cargo, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
