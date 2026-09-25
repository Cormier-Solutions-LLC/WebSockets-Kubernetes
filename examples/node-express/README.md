# Node.js and Express reference application

This small adapter demonstrates a non-production Node.js/Express front end for Cormier.Realtime. It establishes an Express session, writes the gateway-compatible identity record to Redis, forwards connection-ticket requests and WebSocket upgrades to a configured gateway, and serves the repository's canonical browser SDK and shared UI without copying either one.

## Prerequisites and local run

- Node.js 24.x (`package.json` declares `>=24.0.0 <25`; the container pins 24.20.0) and npm. The engine declaration alone is not a runtime rejection.
- Redis 7.4 or a compatible configured service
- A running Cormier.Realtime 0.1.x gateway configured to trust `PUBLIC_ORIGIN` and use the same Redis instance/session prefixes
- Generated SDK and shared UI assets: run `npm ci` then `npm run build` in `sdk/typescript` to produce `sdk/typescript/dist` and `examples/shared-web/dist`.

From `examples/node-express`, copy `.env.example` into your environment, replace `SESSION_SECRET`, and adjust every endpoint and port for the target environment. The file is an example fixture; the application does not read `.env` files or contain network defaults.

```powershell
npm ci
$env:PORT = "15100"
$env:LISTEN_HOST = "127.0.0.1"
$env:TRUST_PROXY_HOPS = "0"
$env:PUBLIC_ORIGIN = "http://127.0.0.1:15100"
$env:GATEWAY_URL = "http://127.0.0.1:15101"
$env:REDIS_URL = "redis://127.0.0.1:16379"
$env:SESSION_SECRET = "replace-with-a-runtime-secret-of-at-least-32-characters"
$env:SESSION_LIFETIME_SECONDS = "1200"
$env:HEARTBEAT_INTERVAL_MILLISECONDS = "15000"
$env:INSTANCE_NAME = "node-express-a"
$env:TOPOLOGY = "non-ha"
$env:REDIS_INSTANCE_PREFIX = "cormier:reference-node"
$env:REDIS_SESSION_KEY_PREFIX = "sessions"
$env:ALLOWED_TENANTS = "tenant-a,tenant-b"
$env:ALLOWED_USERS = "user-a,user-b"
npm start
```

Set `HEARTBEAT_INTERVAL_MILLISECONDS` to the gateway's configured `Realtime:HeartbeatSeconds` multiplied by 1000. The adapter publishes this value through `/api/diagnostics` so the shared browser client uses the same heartbeat cadence.

Startup validates all configuration and exits nonzero on a missing or invalid value or unavailable Redis. `TRUST_PROXY_HOPS` must match the exact number of trusted TLS-terminating proxies (`0` for direct traffic); ticket proxy requests are bounded to ten seconds. Lifecycle and proxy handlers emit structural JSON; Express application handlers log structural objects through the default console logger. They intentionally omit sensitive values, but do not assume all framework logs are redacted. `/health` checks Redis readiness and PING, returning 200 or 503; the global request limiter can also return 429. It does not probe the gateway. Shutdown on `SIGINT` or `SIGTERM` stops accepting work, closes the proxy and Redis client, and allows 15 seconds for WebSocket drain, with a forced-exit timer at 16 seconds.

Run the repeatable checks with `npm ci && npm run check`. Run the container from the repository root so the canonical assets are in scope:

```text
docker build -f examples/node-express/Dockerfile -t cormier-node-express:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15100:15100 --env-file examples/node-express/.env.example --env SESSION_SECRET --env GATEWAY_URL=http://host.docker.internal:15101 --env REDIS_URL=redis://host.docker.internal:16379 cormier-node-express:local
```

Set `SESSION_SECRET` in the invoking shell before the container command; `--env SESSION_SECRET` passes that runtime value. The mapped ports are local fixture values and must match your gateway, Redis and public origin. Replace every fixture value before a real deployment. Do not bake the environment file or a secret into the image.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login and session establishment | Example | Allowlisted fixture identities; authoritative record is in Redis |
| Connection-ticket endpoint | Available | Same-origin POST is forwarded to the gateway |
| WebSocket connection | Available | Upgrade is forwarded; gateway validates Origin and ticket |
| Connect, subscribe, publish, receive, reconnect | Available | Canonical `@cormier/realtime` browser client and shared UI |
| Expired session/ticket and rejected Origin | Available | Redis TTL/session lookup and gateway policy enforce rejection |
| Health and redacted diagnostics | Available | No secrets or network identities returned |
| Logout | Available | Redis and both cookies are removed |
| HA/session replication | Omitted | Default Express `MemoryStore` is process-local |
| Request limiting and CSRF defense | Example | Bounded in-process limiter, exact Origin checks, and SameSite Strict cookies |
| Distributed abuse controls, CSRF tokens, authorization provider | Omitted | Required production controls belong to the adopting application |
| TLS, gateway, Redis, orchestration | External | Always supplied and secured by deployment configuration |

This is a teaching adapter, not a production identity system or reverse proxy. `express-session` and the request limiter use process-local memory. Production adopters must select supported durable session and distributed rate-limit stores, an identity/authorization provider, defense-in-depth CSRF controls, TLS termination, secret manager, telemetry, and availability design.

## Supported versions and footprint

| Component | Repository pin / compatibility | Status |
| --- | --- | --- |
| Node.js | 24.20.0 | Supported example runtime |
| Express | 5.2.1 | Supported example framework |
| express-session | 1.19.0 | Supported middleware; MemoryStore is non-production |
| Cormier.Realtime browser SDK | 1.0.3-beta | Canonical generated shared JavaScript |
| Cormier.Realtime protocol | 1.0 | Supported wire protocol |
| Cormier.Realtime gateway | 0.1.x repository build | Required external dependency |
| Redis | 7.4 | Tested session service |
| Container base | Node 24.20.0 Alpine, pinned OCI index digest | Reproducible multi-platform base |

The stack-specific runtime is six source files and 583 nonblank lines before tests; canonical HTML, CSS, JavaScript, protocol fixtures, and generated SDK files are excluded. Review this number when functionality changes so adapter duplication stays visible.

## Support and diagnostics

For non-sensitive example defects, open a repository issue and include the Node, npm, Express, SDK/protocol, gateway, Redis, and container versions; topology; failing route/scenario; health response; minimal reproduction; and redacted structural logs. Never include secrets, Redis URLs, cookies, session IDs, tickets, tenant/user data, private origins, or network addresses. Follow the repository security policy for suspected vulnerabilities rather than placing sensitive details in a public issue.

See [UPDATE.md](UPDATE.md) for the update, deprecation, verification, and rollback procedure and [CHANGELOG.md](CHANGELOG.md) for operator-visible changes.

The limiter permits 120 HTTP requests per 60-second window per client key; login JSON is limited to 8 KiB. Upgrade traffic bypasses Express middleware, retains the browser Origin for gateway validation, and has a ten-second upstream handshake timeout. Configure the gateway's `Proxy:TrustedNetworks` narrowly for the adapter hop that supplies `X-Forwarded-Proto`. Numeric `TRUST_PROXY_HOPS` is safe only when every ingress path has that trusted hop count and direct access is prevented.

Containers use `/app/shared-web/optimized`; `SHARED_ASSET_ROOT=/app/shared-web/readable` selects the readable UI. `TOPOLOGY=ha` only changes diagnostics and does not replace the process-local session store.
