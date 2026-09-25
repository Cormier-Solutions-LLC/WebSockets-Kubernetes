# Changelog

Operator-visible features, fixes, security/configuration changes, breaking behavior, and required actions are recorded here.

## 1.0.3-beta - 2026-09-25

- See the coordinated release notes in `docs/release-notes/1.0.3-beta.md`.

## 1.0.2-beta - 2026-09-24

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.
- Current build prerequisite: generate both `sdk/typescript/dist` and `examples/shared-web/dist` through the SDK build before testing or packaging. Containers select the optimized UI; `SHARED_ASSET_ROOT=/app/shared-web/readable` selects the readable profile with the same SDK.
- Operational clarification: `/health` checks Redis, not the gateway. Ktor's configured stop bound covers the server stop call; HTTP-client and Redis cleanup follow it. See [README.md](README.md) and [UPDATE.md](UPDATE.md) for current setup and qualification steps; the released entry below is retained.

## 0.1.0 - 2026-09-11

### Added

- Typed Ktor configuration, demonstration login, Lettuce-backed gateway sessions, health/diagnostics, logout, and bounded startup/shutdown.
- Coroutine-based ticket and WebSocket forwarding with Host, Origin, cookie, and subprotocol preservation.
- Canonical UI/CSS/SDK hosting, shared browser scenarios, and configuration/protocol contract tests.
- Checksum-pinned Gradle wrapper, locked dependencies, and digest-pinned non-root container.

### Security and configuration

- No deployable endpoint, credential, identity, session, or ticket is embedded in source or the image.
- WebSocket ticket and reconnect query parameters are preserved when constructing the upstream URL.
- The listener address is runtime-supplied, and configured origins with explicit default HTTP(S) ports are rejected to match browser Origin serialization.
- WebSocket upgrades validate the browser Origin before opening the upstream connection and preserve that validated header unchanged.
- Added a failing HIGH/CRITICAL image scan and upgraded runtime OS packages during image construction.
- Cookies are HTTP-only, SameSite Strict, path-scoped, and Secure under HTTPS; API responses are non-cacheable and browser headers restrictive.
- Framework dependency debug logging is suppressed to prevent configured network identities from entering normal logs.

### Limitations and operator actions

- Production identity, authorization, CSRF/abuse controls, TLS, secrets, telemetry, and orchestration are omitted. Supply them externally.
- Configure adapter/gateway with the same Redis namespace and trusted public origin; build the canonical SDK first.

No fixes, breaking changes, or active deprecations exist in the initial release.
