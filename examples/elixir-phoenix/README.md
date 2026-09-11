# Elixir and Phoenix reference application

This non-production adapter demonstrates a supervised Phoenix front end for Cormier.Realtime. It keeps typed configuration in explicit application state, stores gateway-compatible sessions through Redix, and uses Bandit/WebSock plus Mint.WebSocket to forward the canonical protocol without copying browser assets. `LISTEN_HOST` and `PORT` select the listener explicitly.

## Prerequisites and local run

- Elixir 1.20.4 and Erlang/OTP 29.0.6
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`

For ticket and WebSocket relays, the adapter forwards the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single forwarding hop; never trust public or broader ranges.
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally; the application does not load the fixture. From this directory run `mix deps.get && mix run --no-halt`. The repeatable gate is:

```text
mix format --check-formatted
mix compile --warnings-as-errors
mix test --no-start
mix hex.audit
```

Build/run the multi-architecture, digest-pinned release container from the repository root:

```text
docker build -f examples/elixir-phoenix/Dockerfile -t cormier-elixir-phoenix:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15600:15600 --env-file examples/elixir-phoenix/.env.example --env GATEWAY_URL=http://host.docker.internal:15601 --env REDIS_URL=redis://host.docker.internal:16379 cormier-elixir-phoenix:local
```

Configuration and the synchronous Redis connection fail before the endpoint starts. Redis commands, HTTP, WebSocket connection, body/frame sizes, and shutdown are bounded. Bandit, Redix, and the endpoint run under one OTP supervisor; SIGINT/SIGTERM stops the release supervision tree. Logs expose structural lifecycle/failure events without configured dependency details.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Allowlisted identities; gateway-compatible Redis record |
| Ticket and WebSocket forwarding | Available | Original Host, Origin, cookie, query, and subprotocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK and shared UI |
| Expiry/rejected Origin/gateway outage | Available | Adapter checks, bounded generic failures, gateway policy |
| Health and diagnostics | Available | Redis-aware and redacted |
| Supervision/cancellation | Available | OTP-supervised dependencies and per-connection relay process |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Elixir / Erlang | 1.20.4 / OTP 29.0.6 | Current pinned releases |
| Phoenix / Bandit | 1.8.13 / 1.12.5 | Supported endpoint stack |
| Redix / Req / Mint.WebSocket | 1.9.1 / 0.7.4 / 1.0.6 | Locked dependency clients |
| Hex graph | `mix.lock` | Locked; `mix hex.audit` required |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |
| Container base | Hex Elixir 1.20.4, OTP 29.0.6, Alpine 3.24.1 | Digest-pinned amd64/arm64 index |

The adapter has nine stack-specific Elixir/config files and 590 nonblank lines, including tests. Shared assets, fixtures, generated SDK, dependency/build metadata, and docs are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Elixir/OTP/Phoenix/Hex, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
