# Kotlin and Ktor reference application

This small, non-production adapter demonstrates a coroutine-native Ktor front end for Cormier.Realtime. It creates a gateway-compatible Redis session, forwards connection-ticket and WebSocket traffic while preserving the browser Host, and serves the repository's canonical browser SDK and shared UI without copying them.

## Prerequisites and local run

- Java 25; Kotlin/JVM output targets Java 25
- Redis 7.4 or a compatible configured service
- A Cormier.Realtime 0.1.x gateway that trusts `PUBLIC_ORIGIN` and uses the same Redis prefixes

For ticket and WebSocket relays, the adapter forwards the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single forwarding hop; never trust public or broader ranges.
Generate `sdk/typescript/dist` and `examples/shared-web/dist` before tests or container builds: with Node.js 22+, run `npm ci` then `npm run build` in `sdk/typescript`.

Supply every value shown in `.env.example`; it is a fixture and is not loaded automatically. From `examples/kotlin-ktor` on PowerShell:

```powershell
$env:PORT = "15300"
$env:LISTEN_HOST = "127.0.0.1"
$env:PUBLIC_ORIGIN = "http://127.0.0.1:15300"
$env:GATEWAY_URL = "http://127.0.0.1:15301"
$env:REDIS_URL = "redis://127.0.0.1:16379"
$env:SESSION_LIFETIME_SECONDS = "1200"
$env:HEARTBEAT_INTERVAL_MILLISECONDS = "15000"
$env:INSTANCE_NAME = "kotlin-ktor-a"
$env:TOPOLOGY = "non-ha"
$env:REDIS_INSTANCE_PREFIX = "cormier:reference-kotlin"
$env:REDIS_SESSION_KEY_PREFIX = "sessions"
$env:ALLOWED_TENANTS = "tenant-a,tenant-b"
$env:ALLOWED_USERS = "user-a,user-b"
./gradlew.bat run
```

Set `HEARTBEAT_INTERVAL_MILLISECONDS` to the gateway's configured `Realtime:HeartbeatSeconds` multiplied by 1000. The adapter publishes this value through `/api/diagnostics` so the shared browser client uses the same heartbeat cadence.

The wrapper pins Gradle 9.7.1 and verifies its distribution checksum; `gradle.lockfile` pins all application and test modules. Run `./gradlew test` (`gradlew.bat` on Windows) for locked checks. Build and run the digest-pinned container from the repository root:

```text
docker build -f examples/kotlin-ktor/Dockerfile -t cormier-kotlin-ktor:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15300:15300 --env-file examples/kotlin-ktor/.env.example --env GATEWAY_URL=http://host.docker.internal:15301 --env REDIS_URL=redis://host.docker.internal:16379 cormier-kotlin-ktor:local
```

Typed configuration validation rejects unsafe origins, Redis schemes, identifiers, topology, TTL, ports, or allowlists before binding the server. Lettuce is configured with a five-second timeout. `/health` reports Redis availability (200 or 503), not gateway reachability. Shutdown calls Ktor server stop with one second of grace and a 15-second timeout, then closes the HTTP client and Redis store; Redis client shutdown has its own five-second bound. Request failures return generic codes, and application logging records exception classes while Redis/Netty internals are disabled to limit dependency detail in normal logs; inspect framework and deployment logs before sharing and do not enable sensitive request/debug logging.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login and session establishment | Example | Allowlisted fixture identities; authoritative record is in Redis |
| Connection-ticket endpoint | Available | Same-origin POST is forwarded with original Host and cookie |
| WebSocket connection | Available | Coroutine relay forwards text/binary frames and the required subprotocol |
| Connect, subscribe, publish, receive, reconnect | Available | Canonical browser client and shared UI |
| Expired session/ticket and rejected Origin | Available | Adapter session checks plus gateway ticket/Origin policy |
| Health and redacted diagnostics | Available | Dependency-aware health without network identities |
| Logout | Available | Redis session and cookie are removed |
| Coroutine cancellation | Available | Relay direction is cancelled when its peer completes; engine shutdown is bounded |
| Identity, rate limiting, CSRF tokens, authorization policy | Omitted | Required production controls belong to the adopting application |
| TLS, gateway, Redis, orchestration | External | Always supplied and secured through deployment configuration |

This is a teaching adapter, not a production identity system or general-purpose reverse proxy. Production adopters must provide durable identity and authorization, CSRF and abuse controls, TLS, secrets, telemetry, proxy hardening, and an availability design.

## Supported versions and footprint

| Component | Repository pin / compatibility | Status |
| --- | --- | --- |
| Java | 25 | Required runtime and bytecode target |
| Kotlin | 2.4.20 | Pinned compiler/standard-library line |
| Ktor | 3.5.2 | Pinned server/client/WebSocket framework |
| Gradle wrapper | 9.7.1 | Checksum-pinned; dependency locking enabled |
| Lettuce | 7.6.0 | Pinned Redis client |
| Cormier.Realtime browser SDK / protocol | 1.0.3-beta / 1.0 | Canonical generated SDK and wire contract |
| Cormier.Realtime gateway | 0.1.x repository build | Required external dependency |
| Redis | 7.4 | Tested session service |
| Container bases | Gradle 9.7.1 JDK 25; Temurin 25 JRE Alpine | Both OCI indexes are digest-pinned |

The adapter has three stack-specific production Kotlin files and 416 nonblank lines. Canonical assets, protocol fixtures, generated SDK, tests, build metadata, and logging configuration are excluded. Recalculate this footprint when functionality changes.

## Support and diagnostics

Open a repository issue for a non-sensitive defect and include Java, Kotlin, Ktor, Gradle, Lettuce, SDK/protocol, gateway, Redis, and container versions; topology; failing route/scenario; health response; minimal reproduction; and redacted logs. Never include credentials, Redis URLs, cookies, session IDs, tickets, tenant/user data, private origins, or network addresses. Use the repository security policy for suspected vulnerabilities.

See [UPDATE.md](UPDATE.md) for update/deprecation/rollback guidance and [CHANGELOG.md](CHANGELOG.md) for operator-visible changes.

Ticket requests use a five-second connect timeout and 15-second request/socket timeouts; these are not a lifetime limit for WebSockets. Login/ticket bodies and ticket responses are capped at 64 KiB; both WebSocket plugins use a 64 KiB frame limit. The server sends pings every 20 seconds with a 10-second timeout. Keep gateway limits compatible.

Local assets resolve relative to the example directory. Containers use `/app/shared-web/optimized`; select `SHARED_ASSET_ROOT=/app/shared-web/readable` for UI diagnosis. `TOPOLOGY` labels diagnostics and does not provision HA infrastructure.
