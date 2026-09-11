# Changelog

## Unreleased

### Added

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.

- Minimal Gin adapter with typed configuration, allowlisted example login, Redis sessions, ticket and WebSocket forwarding, shared assets, health/diagnostics, bounded dependency operations, and graceful shutdown.
- Locked Go module graph, digest-pinned non-root container, contract tests, vet gate, and shared browser coverage.

### Security

- Exact Origin checks, strict HttpOnly session cookie, safe asset names, request size/time bounds, restrictive browser headers, generic dependency errors, and redacted structural logs.

### Known limitations

- Example identities and authorization are non-production; TLS, durable Redis/gateway operation, orchestration, rate limiting, and production CSRF/abuse controls remain external.

### Changed, fixed, deprecated, removed

- Fixed WebSocket query forwarding, made the listener host explicitly configurable, and rejected noncanonical origins with explicit default HTTP(S) ports.
- Added a failing HIGH/CRITICAL image scan and upgraded runtime OS packages during image construction.
- Future deprecations must identify a replacement, migration and rollback instructions, verification, and the removal release/support window before behavior changes.

### Operator action

- Supply all required configuration and compatible Redis/gateway/SDK assets, then follow `UPDATE.md`. No migration is required for the initial version.
