# Changelog

## 1.0.3-beta - 2026-09-25

- See the coordinated release notes in `docs/release-notes/1.0.3-beta.md`.

## 1.0.2-beta - 2026-09-24

### Added

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.

- Minimal supervised Phoenix/Bandit adapter with typed configuration, example login, Redis sessions, ticket and WebSocket forwarding, shared assets, health/diagnostics, bounded operations, and release shutdown.
- Locked Hex graph, advisory audit, digest-pinned non-root release container, contract tests, and shared browser coverage.

### Security

- Exact Origin checks, strict HttpOnly cookie, safe asset names, body/frame/time bounds, verified `wss` CA store, restrictive browser headers, generic dependency errors, and redacted structural logs.

### Known limitations

- Example identities and authorization are non-production; TLS termination, durable Redis/gateway operation, orchestration, rate limiting, and production CSRF/abuse controls remain external.

### Changed, fixed, deprecated, removed

- Fixed WebSocket query forwarding, made the listener host explicitly configurable, and rejected noncanonical origins with explicit default HTTP(S) ports.
- Added a failing HIGH/CRITICAL image scan and upgraded runtime OS packages during image construction.
- Clarified that `.env.example` is an external configuration template, not an application-loaded file, and that generated SDK/shared-web assets must come from the same verified build.
- Future deprecations must identify a replacement, migration/rollback instructions, verification, and removal release/support window before behavior changes.

### Operator action

- Build the canonical SDK/shared-web assets, supply every `.env.example` setting through the process environment, provide compatible Redis and gateway instances, then follow `UPDATE.md`. No data migration is required for the initial version.
