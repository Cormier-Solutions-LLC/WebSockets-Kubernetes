# Changelog

## 0.1.0 - 2026-09-11

### Added

- Typed configuration, explicit Axum state, allowlisted login, async Redis sessions, logout, health, and diagnostics.
- Bounded ticket forwarding and cancellable bidirectional WebSocket relay with Host/Origin/cookie/subprotocol preservation.
- Canonical assets, shared browser scenarios, configuration/protocol contract checks, locked Cargo graph, and digest-pinned non-root image.

### Security and configuration

- No deployable endpoint, credential, identity, session, or ticket is embedded; errors/logs omit underlying values.
- The listener host is supplied explicitly and WebSocket ticket/reconnect queries are preserved upstream.
- `rediss://` now uses Rustls with Web PKI roots, and noncanonical origins with explicit default HTTP(S) ports are rejected.
- Added a failing HIGH/CRITICAL image scan and upgraded runtime OS packages during image construction.
- HTTP-only SameSite Strict cookies, restrictive browser headers, no-store responses, Origin validation, and bounded dependency work.

### Limitations and actions

- Production identity/authorization, CSRF/abuse controls, TLS termination, secrets, telemetry, and orchestration are omitted and must be supplied externally.
- Configure the adapter/gateway with the same Redis namespace and trusted public origin; build the canonical SDK first.

No fixes, breaking changes, or active deprecations exist in this initial release.
