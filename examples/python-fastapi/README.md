# Python and FastAPI reference application

This non-production adapter demonstrates a typed, asynchronous FastAPI front end for Cormier.Realtime. It validates configuration with Pydantic Settings, stores gateway-compatible sessions with the async Redis client, forwards tickets with HTTPX, and relays the canonical WebSocket protocol with WebSockets. Shared HTML, CSS, generated JavaScript, schema, fixtures, and browser tests remain external sources of truth.

## Prerequisites and local run

- Python 3.14.7 and uv 0.12.13
- FastAPI 0.141.1, Uvicorn 0.52.4, Redis 8.1.0, HTTPX 0.28.1, WebSockets 17.1, and Pydantic Settings 2.15.0 from `uv.lock`
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway sharing the configured prefixes and trusted `PUBLIC_ORIGIN`

When the adapter forwards an HTTPS public origin to an internal HTTP gateway, it supplies the validated public scheme in `X-Forwarded-Proto` for ticket and WebSocket requests. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so the gateway accepts that single trusted forwarding hop; never trust a public or broader network range.
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally, including the explicit `LISTEN_HOST` and `PORT`, and adjust all network values for the target environment; the application does not load the fixture. From this directory run `uv sync --frozen`, `uv run python -m reference_app`, and this repeatable gate:

```text
uv lock --check
uv run ruff check .
uv run ruff format --check .
uv run pytest
uv run pip-audit --local
```

Build and run the digest-pinned, multi-architecture container from the repository root:

```text
docker build -f examples/python-fastapi/Dockerfile -t cormier-python-fastapi:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/python-fastapi/.env.example -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:16379 cormier-python-fastapi:local
```

FastAPI lifespan validation checks configuration, Redis, and canonical assets before bind. Uvicorn rejects browser WebSocket messages above the gateway's 64 KiB boundary before the relay materializes them. Redis, HTTP, WebSocket open/close, request, and graceful-shutdown waits are bounded. Logs contain structural lifecycle/failure events only; dependency request logs are suppressed. The image runs as numeric user/group 65532.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Allowlisted identities; gateway-compatible Redis record and secure cookie flags |
| Ticket and WebSocket forwarding | Available | Full browser authority, Origin, cookie, query, and subprotocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK, protocol, UI, and shared smoke suite |
| Expiry/rejected Origin/gateway outage | Available | Session TTL/revalidation, strict Origin, bounded generic failures |
| Health and diagnostics | Available | Redis-aware and redacted |
| Startup/shutdown | Available | FastAPI lifespan plus bounded Uvicorn signal handling |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Python / uv | 3.14.7 / 0.12.13 | Exact runtime/tool pins |
| FastAPI / Uvicorn | 0.141.1 / 0.52.4 | Exact locked application dependencies |
| Redis / HTTPX / WebSockets / Pydantic Settings | 8.1.0 / 0.28.1 / 17.1 / 2.15.0 | Exact locked clients/configuration |
| Python graph | `uv.lock` | Locked; local audit required |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |

The adapter has seven stack-specific Python/test files and 804 nonblank lines. Generated environments, shared assets/fixtures, lock/build metadata, browser harness configuration, and documentation are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Python, FastAPI, Uvicorn, uv/lock, client-library, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the repository security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
