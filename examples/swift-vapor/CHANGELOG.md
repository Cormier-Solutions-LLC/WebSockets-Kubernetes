# Changelog

## 0.1.0

- Added the Swift 6.3 / Vapor 4.121 reference adapter with strict settings, allowlisted login, opaque cookie state, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded Redis operations, HTTP ticket forwarding, and Caddy WebSocket relay while preserving browser authority, Origin, cookie, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact package requirements and resolved graph, strict formatter/tests gate, digest-pinned non-root image, supervised lifecycle behavior, platform/update/rollback instructions, and non-production limitations.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
