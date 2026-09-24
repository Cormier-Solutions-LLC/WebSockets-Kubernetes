# Changelog

## 1.0.2-beta - 2026-09-24

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.

## 0.1.0

- Added the Swift 6.3.3 / Vapor 4.121.4 / Vapor Redis 4.14.0 reference adapter with strict settings, allowlisted login, opaque cookie state, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded Redis operations, HTTP ticket forwarding, and Caddy WebSocket relay while preserving browser authority, Origin, cookie, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact package requirements and resolved graph, strict formatter/tests gate, digest-pinned non-root image, supervised lifecycle behavior, platform/update/rollback instructions, and non-production limitations.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Made the Caddy listener host runtime-supplied and rejected noncanonical configured origins with explicit default HTTP(S) ports.
- Returned the canonical authenticated session-status shape and documented the Swift listener/Caddy settings in the shared environment schema.
- Added a failing HIGH/CRITICAL image scan, upgraded runtime OS packages, and built Caddy with patched Go dependencies.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
