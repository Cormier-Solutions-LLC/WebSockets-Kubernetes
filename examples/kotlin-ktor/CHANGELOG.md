# Changelog

Operator-visible features, fixes, security/configuration changes, breaking behavior, and required actions are recorded here.

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
