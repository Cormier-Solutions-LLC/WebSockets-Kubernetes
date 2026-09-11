# Changelog

## 0.1.0

- Added the Python 3.14 / FastAPI reference adapter with typed settings, allowlisted login, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded HTTP ticket forwarding and an asynchronous WebSocket relay preserving browser authority, Origin, cookie, query, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact `uv.lock` dependencies, Ruff/Pytest/pip-audit gates, digest-pinned non-root image, explicit lifespan behavior, update/rollback instructions, and non-production limitations.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
- Fixed default HTTP(S) gateway port selection and made the listener host explicit.
