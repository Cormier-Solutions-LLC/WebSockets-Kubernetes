# PHP and Laravel reference application

This non-production adapter demonstrates a minimal Laravel front end for Cormier.Realtime. Laravel supplies typed configuration, its HTTP and Redis clients, routing, validation, cookie/session middleware, and gateway-compatible session records. FrankenPHP serves Laravel and Caddy forwards only the raw WebSocket upgrade, preserving the browser Host (including port), Origin, cookie, query, and subprotocol. Canonical browser assets remain external to this directory and are copied into the image from their generated repository locations.

## Prerequisites and local run

- PHP 8.5 and Composer 2.10.3
- Laravel 13.31.0 and Predis 3.6.0 from `composer.lock`
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway using the same Redis prefixes and trusted `PUBLIC_ORIGIN`
- FrankenPHP 1.12.7 for the documented direct or container run
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally, replace `SESSION_SECRET`, and adjust all endpoints and ports for the target environment; the application does not load the fixture. `PUBLIC_ROOT=public` supports this documented working-directory launch and can be replaced with an absolute deployment path. From this directory run `composer install` and then `php artisan app:preflight`. Start FrankenPHP with `frankenphp run --config Caddyfile --adapter caddyfile`. The repeatable gate is:

```text
composer validate --no-check-publish
vendor/bin/pint --test
vendor/bin/phpunit
composer audit --locked
```

Build and run the digest-pinned, multi-architecture image from the repository root:

```text
docker build -f examples/php-laravel/Dockerfile -t cormier-php-laravel:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/php-laravel/.env.example -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:16379 cormier-php-laravel:local
```

Preflight validates configuration, Redis, and canonical assets before bind. Caddy binds the runtime-supplied `LISTEN_HOST` and port and rejects login and ticket bodies larger than 64 KiB before PHP buffers them, including requests without `Content-Length`. Ticket and WebSocket relays send the scheme derived from validated `PUBLIC_ORIGIN`; configure the gateway to trust only the adapter network. HTTP dependencies have finite connection/request deadlines, Caddy has bounded request/idle timeouts, and a pinned init forwards termination and reaps workers for clean container shutdown. Logs are structural and deliberately omit configured endpoints, cookies, sessions, tickets, identities, and secrets. The image runs as numeric user/group 65532.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Laravel cookie middleware and Redis manager; gateway-compatible record |
| Ticket forwarding | Available | Laravel HTTP client; original authority, Origin, cookie, and content type |
| WebSocket forwarding | Available | Caddy upgrade path preserves full Host authority and browser headers |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK, protocol, UI, and shared smoke suite |
| Expiry/rejected Origin/gateway outage | Available | Session TTL, gateway policy, bounded generic failures |
| Health and diagnostics | Available | Redis-aware and redacted |
| Graceful shutdown | Available | FrankenPHP/Caddy signal handling and bounded container stop |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| PHP | 8.5.10 tooling; 8.5.9 in pinned image | Supported 8.5 line |
| Laravel / Predis | 13.31.0 / 3.6.0 | Exact locked application dependencies |
| Composer / dependency graph | 2.10.3 / `composer.lock` | Locked; audit required |
| FrankenPHP | 1.12.7 | Digest-pinned amd64/arm64-capable image |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |

The adapter has 15 stack-specific PHP/configuration/test files and 715 nonblank lines. Generated dependencies, shared assets/fixtures, lock/build metadata, and documentation are excluded. Recalculate after changes.

## Support and limitations

Open a repository issue for non-sensitive defects with PHP, Laravel, Composer, Predis, FrankenPHP, SDK/protocol/gateway, Redis, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, configured URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the repository security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
