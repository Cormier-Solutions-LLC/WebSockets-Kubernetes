# PHP and Laravel reference application

This non-production adapter demonstrates a minimal Laravel front end for Cormier.Realtime. Laravel supplies typed configuration, its HTTP and Redis clients, routing, validation, cookie/session middleware, and gateway-compatible session records. FrankenPHP serves Laravel and Caddy forwards only the raw WebSocket upgrade, preserving the browser Host (including port), Origin, cookie, query, and subprotocol. Canonical browser assets remain external to this directory and are copied into the image from their generated repository locations.

## Prerequisites and local run

- PHP 8.5 and Composer 2.10.3
- Laravel 13.31.0 and Predis 3.6.0 from `composer.lock`
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`
- FrankenPHP 1.12.7 for the documented direct or container run
- Node.js 22+ and npm to generate both `sdk/typescript/dist` and `examples/shared-web/dist`: run `npm ci` then `npm run build` in `sdk/typescript`.

Supply every `.env.example` value externally, replace `SESSION_SECRET`, and adjust all endpoints and ports for the target environment; the application does not load `.env.example` automatically. Laravel may load a local `.env`, so keep any real values outside source control. `PUBLIC_ROOT=public` supports this documented working-directory launch and can be replaced with an absolute deployment path. From this directory run `composer install` and then `php artisan app:preflight`. Before direct startup, export `PUBLIC_SCHEME` as the validated origin scheme (`http` or `https`); in PowerShell use `$env:PUBLIC_SCHEME = ([uri]$env:PUBLIC_ORIGIN).Scheme`. Then run `frankenphp run --config Caddyfile --adapter caddyfile`. Unlike the container startup script, this direct command does not run preflight or derive the scheme for you. The repeatable gate is:

```text
composer validate --no-check-publish
vendor/bin/pint --test
vendor/bin/phpunit
composer audit --locked
```

Build and run the digest-pinned, multi-architecture image from the repository root:

```text
docker build -f examples/php-laravel/Dockerfile -t cormier-php-laravel:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/php-laravel/.env.example -e SESSION_SECRET -e PUBLIC_ROOT=/app/public -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:16379 cormier-php-laravel:local
```

Set `SESSION_SECRET` in the invoking shell before the container command. Preflight validates configuration, Redis, and canonical assets before bind when explicitly run or invoked by `start.sh`; it does not probe the gateway. Caddy binds the runtime-supplied `LISTEN_HOST` and port and rejects login and ticket bodies larger than 64 KiB before PHP buffers them, including requests without `Content-Length`. Ticket and WebSocket relays send the scheme derived from validated `PUBLIC_ORIGIN`; configure the gateway to trust only the adapter network. HTTP dependencies have finite connection/request deadlines, Caddy has bounded request/idle timeouts, and a pinned init forwards termination and reaps workers. `start.sh` waits for FrankenPHP without a forced-kill timer; set the container/orchestrator stop timeout. Logs are structural and deliberately omit configured endpoints, cookies, sessions, tickets, identities, and secrets. The image runs as numeric user/group 65532.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Laravel cookie middleware and Redis manager; gateway-compatible record |
| Ticket forwarding | Available | Laravel HTTP client; original authority, Origin, cookie, and content type |
| WebSocket forwarding | Available | Caddy upgrade path preserves full Host authority and browser headers |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK, protocol, UI, and shared smoke suite |
| Expiry/rejected Origin/gateway outage | Available | Session TTL, gateway policy, bounded generic failures |
| Health and diagnostics | Available | Redis-aware and redacted |
| Graceful shutdown | Available | FrankenPHP/Caddy signal handling; stop deadline supplied by deployment |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Repository pin / compatibility | Status |
| --- | --- | --- |
| PHP | `8.5.*` Composer constraint; PHP 8.5 base image | Inspect `php --version` in the built image for its exact patch |
| Laravel / Predis | 13.31.0 / 3.6.0 | Exact locked application dependencies |
| Composer / dependency graph | 2.10.3 / `composer.lock` | Locked; audit required |
| FrankenPHP | 1.12.7 | Digest-pinned amd64/arm64-capable image |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |

The adapter has 15 stack-specific PHP/configuration/test files and 715 nonblank lines. Generated dependencies, shared assets/fixtures, lock/build metadata, and documentation are excluded. Recalculate after changes.

## Support and limitations

Open a repository issue for non-sensitive defects with PHP, Laravel, Composer, Predis, FrankenPHP, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, configured URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the repository security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).

`/health` returns 200 on successful Redis PING and 503 on failure. `/api/diagnostics` includes Redis state, instance and topology; `TOPOLOGY` does not provision replicas. Gateway identity uses the plaintext, HttpOnly `cormier_session` identifier backed by Redis; Laravel's separate session driver is `array`. Login, logout and ticket routes are exempt from Laravel CSRF-token middleware and rely on exact Origin checks here; WebSocket Origin/authentication enforcement belongs to the gateway.

Containers default to `/app/shared-web/optimized`; choose `SHARED_ASSET_ROOT=/app/shared-web/readable` for the readable UI. Direct runs use shared repository asset paths. Both profiles need a matching generated SDK.
