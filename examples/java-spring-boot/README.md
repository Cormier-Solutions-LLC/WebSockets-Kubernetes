# Java and Spring Boot reference application

This small, non-production adapter demonstrates a Spring Boot front end for Cormier.Realtime. It creates a gateway-compatible Redis session, forwards connection-ticket and WebSocket traffic through Spring Cloud Gateway with the original Host header, and serves the repository's canonical browser SDK and shared UI without copying them.

## Prerequisites and local run

- Java 25 (the Maven build enforces the configured release)
- Redis 7.4 or a compatible configured service
- A Cormier.Realtime 0.1.x gateway that trusts `PUBLIC_ORIGIN` and uses the same Redis instance/session prefixes
- The generated `sdk/typescript/dist` assets (`npm ci && npm run build` in `sdk/typescript`)

Ticket and WebSocket routes forward the scheme from validated `PUBLIC_ORIGIN` in `X-Forwarded-Proto`. Configure the gateway's `Proxy:TrustedNetworks` with only the adapter network CIDR so it accepts that single trusted forwarding hop; never trust a public or broader network range.

From `examples/java-spring-boot`, supply every value shown in `.env.example`; the application does not load that file or contain deployable network defaults. On PowerShell:

```powershell
$env:PORT = "15200"
$env:LISTEN_HOST = "127.0.0.1"
$env:PUBLIC_ORIGIN = "http://127.0.0.1:15200"
$env:GATEWAY_URL = "http://127.0.0.1:15201"
$env:REDIS_URL = "redis://127.0.0.1:16379"
$env:SESSION_LIFETIME_SECONDS = "1200"
$env:INSTANCE_NAME = "java-spring-a"
$env:TOPOLOGY = "non-ha"
$env:REDIS_INSTANCE_PREFIX = "cormier:reference-java"
$env:REDIS_SESSION_KEY_PREFIX = "sessions"
$env:ALLOWED_TENANTS = "tenant-a,tenant-b"
$env:ALLOWED_USERS = "user-a,user-b"
./mvnw.cmd spring-boot:run
```

The Maven wrapper pins Maven 3.9.12 and verifies its distribution checksum. Run repeatable checks with `./mvnw verify` (`mvnw.cmd` on Windows). From the repository root, build and run the digest-pinned multi-stage container:

```text
docker build -f examples/java-spring-boot/Dockerfile -t cormier-java-spring:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15200:15200 --env-file examples/java-spring-boot/.env.example --env GATEWAY_URL=http://host.docker.internal:15201 --env REDIS_URL=redis://host.docker.internal:16379 cormier-java-spring:local
```

Configuration-property validation fails startup with a nonzero exit when an origin, topology, identifier, TTL, or allowlist is unsafe. The ticket route has a 15-second response timeout without imposing that deadline on long-lived WebSockets, and Spring Boot graceful shutdown has a 15-second bound. `/health` returns 200 only when Redis is reachable. Errors expose generic codes while logs contain exception classes rather than request data, cookies, session identifiers, tickets, credentials, or endpoints.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login and session establishment | Example | Allowlisted fixture identities; authoritative record is in Redis |
| Connection-ticket endpoint | Available | Same-origin POST is forwarded with the original Host header |
| WebSocket connection | Available | Spring Cloud Gateway forwards upgrade traffic and the gateway validates Origin/ticket |
| Connect, subscribe, publish, receive, reconnect | Available | Canonical browser client and shared UI |
| Expired session/ticket and rejected Origin | Available | Redis TTL/session lookup and gateway policy enforce rejection |
| Health and redacted diagnostics | Available | Actuator-compatible dependency-aware health behavior; no network identities returned |
| Logout | Available | Redis session and cookie are removed |
| HA/session replication | External | Redis supports shared identity records; deployment topology remains operator-owned |
| Identity provider, rate limiting, CSRF tokens, authorization policy | Omitted | Required production controls belong to the adopting application |
| TLS, gateway, Redis, orchestration | External | Always supplied and secured by deployment configuration |

This is a teaching adapter, not a production identity system or general-purpose reverse proxy. Production adopters must provide durable identity and authorization, CSRF and abuse controls, TLS termination, secret management, telemetry, gateway hardening, and an availability design.

## Supported versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Java | 25 | Supported example runtime |
| Maven wrapper | 3.9.12 | Pinned build tool with distribution checksum |
| Spring Boot | 4.1.1 | Supported example framework |
| Spring Cloud / Gateway | 2025.1.3 / 5.0.3 | Supported forwarding layer |
| Cormier.Realtime browser SDK | 0.1.0 | Canonical generated shared JavaScript |
| Cormier.Realtime protocol | 1.0 | Supported wire protocol |
| Cormier.Realtime gateway | 0.1.x repository build | Required external dependency |
| Redis | 7.4 | Tested session service |
| Container bases | Maven 3.9.12 + Temurin 25; Temurin 25 JRE Alpine | Both OCI indexes are digest-pinned |

The adapter has four stack-specific production Java files and 342 nonblank lines. Canonical HTML, CSS, JavaScript, protocol fixtures, generated SDK files, tests, and build metadata are excluded. Recalculate this footprint when functionality changes so duplication stays visible.

## Support and diagnostics

For a non-sensitive defect, open a repository issue with Java, Maven, Spring Boot/Cloud, SDK/protocol, gateway, Redis, and container versions; topology; failing route/scenario; health response; minimal reproduction; and redacted structural logs. Never include credentials, Redis URLs, cookies, session IDs, tickets, tenant/user data, private origins, or network addresses. Use the repository security policy for suspected vulnerabilities.

See [UPDATE.md](UPDATE.md) for the tested update, deprecation, verification, and rollback flow and [CHANGELOG.md](CHANGELOG.md) for operator-visible changes.
