# Ruby on Rails reference application

This non-production adapter demonstrates a compact Rails front end for Cormier.Realtime. Rails provides encrypted cookie-session middleware, strict configuration, gateway-compatible Redis session records, ticket forwarding, health/diagnostics, and canonical asset delivery. Caddy relays only the raw WebSocket route. Shared HTML, CSS, generated JavaScript, schema, fixtures, and browser tests remain external sources of truth.

## Prerequisites and local run

- Ruby 4.0.6 and Bundler 4.0.20
- Rails 8.1.3.1, Puma 8.0.2, Redis 6.0.0, and JSON 2.21.2 from `Gemfile.lock`
- Redis 7.4 and a Cormier.Realtime 0.1.x gateway sharing the configured prefixes and trusted `PUBLIC_ORIGIN`
- Generated `sdk/typescript/dist` assets

Supply every `.env.example` value externally and adjust all network values for the target environment; the application does not load the fixture. From this directory run `bundle _4.0.20_ install` and this repeatable gate:

```text
bundle _4.0.20_ check
bundle _4.0.20_ exec rubocop
bundle _4.0.20_ exec ruby test/reference_config_test.rb
bundle _4.0.20_ exec brakeman --no-pager --quiet
bundle _4.0.20_ exec bundle-audit check --update
```

Build and run the digest-pinned container from the repository root:

```text
docker build -f examples/ruby-rails/Dockerfile -t cormier-ruby-rails:local .
docker run --rm --add-host host.docker.internal:host-gateway -p 127.0.0.1:15500:15500 --env-file examples/ruby-rails/.env.example -e GATEWAY_URL=http://host.docker.internal:15501 -e REDIS_URL=redis://host.docker.internal:16379 cormier-ruby-rails:local
```

Configuration, Redis, and canonical assets are checked before the public listener binds. Puma remains private on a Unix socket; Caddy exposes the configured `LISTEN_HOST` and port. Ticket and WebSocket relays forward browser authority and the scheme derived from validated `PUBLIC_ORIGIN`; configure the gateway to trust only the adapter network. HTTP and Redis waits are bounded. Logs contain structural lifecycle/failure events and error types only. Tini supervises graceful shutdown, and the image runs as numeric user/group 65532.

## Feature matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Login/session/logout | Example | Rails encrypted session plus allowlisted gateway-compatible Redis record |
| Ticket and WebSocket forwarding | Available | Browser authority, Origin, cookie, and protocol preserved |
| Connect/subscribe/publish/receive/reconnect | Available | Canonical browser SDK, protocol, UI, and shared smoke suite |
| Expiry/rejected Origin/gateway outage | Available | Session TTL/revalidation, strict Origin, bounded generic failures |
| Health and diagnostics | Available | Redis-aware and redacted |
| Startup/shutdown | Available | Pre-bind validation and supervised Puma/Caddy termination |
| Production identity, authorization, CSRF/abuse controls | Omitted | Adopting application responsibility |
| TLS, Redis, gateway, orchestration | External | Deployment-supplied configuration |

This is a teaching adapter, not a production identity system or general reverse proxy.

## Versions and footprint

| Component | Tested version | Status |
| --- | --- | --- |
| Ruby / Bundler | 4.0.6 / 4.0.20 | Exact runtime/tool pins |
| Rails / Puma | 8.1.3.1 / 8.0.2 | Exact locked framework/server dependencies |
| Redis / JSON | 6.0.0 / 2.21.2 | Exact locked client and Rails-compatible JSON line |
| Ruby graph | `Gemfile.lock` | Locked; Brakeman and bundler-audit required |
| Caddy | 2.11.4 | Digest-pinned WebSocket edge |
| Cormier.Realtime SDK / protocol / gateway | 0.1.0 / 1.0 / 0.1.x | Canonical assets and external gateway |
| Redis | 7.4 | Tested dependency |

The adapter has 12 stack-specific Ruby/test files and 462 nonblank lines. Vendored gems, shared assets/fixtures, lock/build metadata, browser harness configuration, and documentation are excluded. Recalculate after changes.

## Support

Open a repository issue for non-sensitive defects with Ruby, Rails, Puma, Bundler/lock, client-library, SDK/protocol/gateway, Redis, Caddy, and container versions; topology; scenario; health response; reproduction; and redacted structural logs. Never include credentials, URLs, cookies, session IDs, tickets, identities, private origins, or addresses. Use the repository security policy for vulnerabilities. See [UPDATE.md](UPDATE.md) and [CHANGELOG.md](CHANGELOG.md).
