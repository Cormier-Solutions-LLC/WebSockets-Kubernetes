# Changelog

## Unreleased

### Added

- Minimal supervised Phoenix/Bandit adapter with typed configuration, example login, Redis sessions, ticket and WebSocket forwarding, shared assets, health/diagnostics, bounded operations, and release shutdown.
- Locked Hex graph, advisory audit, digest-pinned non-root release container, contract tests, and shared browser coverage.

### Security

- Exact Origin checks, strict HttpOnly cookie, safe asset names, body/frame/time bounds, verified `wss` CA store, restrictive browser headers, generic dependency errors, and redacted structural logs.

### Known limitations

- Example identities and authorization are non-production; TLS termination, durable Redis/gateway operation, orchestration, rate limiting, and production CSRF/abuse controls remain external.

### Changed, fixed, deprecated, removed

- None. Future deprecations must identify a replacement, migration/rollback instructions, verification, and removal release/support window before behavior changes.

### Operator action

- Supply required configuration and compatible Redis/gateway/SDK assets, then follow `UPDATE.md`. No migration is required for the initial version.
