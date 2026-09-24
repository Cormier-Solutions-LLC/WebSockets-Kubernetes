# Changelog

## 1.0.2-beta - 2026-09-24

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.
- Build prerequisite: with Node.js 22+, run `npm --prefix sdk/typescript ci` and `npm --prefix sdk/typescript run build` from the repository root to generate both `sdk/typescript/dist` and `examples/shared-web/dist` before image construction. `SHARED_ASSET_ROOT=/app/shared-web/readable` selects the container's readable UI profile with the same SDK.
- Current operational clarification: `/health` checks Redis, not gateway reachability. The documented `python -m reference_app` launcher supplies Uvicorn's 64 KiB WebSocket limit and 15-second graceful-shutdown setting; an alternative ASGI launch must configure equivalent limits explicitly. See [README.md](README.md) and [UPDATE.md](UPDATE.md). The initial release entry below is retained.

## 0.1.0

- Added the Python 3.14 / FastAPI reference adapter with typed settings, allowlisted login, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded HTTP ticket forwarding and an asynchronous WebSocket relay preserving browser authority, Origin, cookie, query, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact `uv.lock` dependencies, Ruff/Pytest/pip-audit gates, digest-pinned non-root image, explicit lifespan behavior, update/rollback instructions, and non-production limitations.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
- Fixed default HTTP(S) gateway port selection and made the listener host explicit.
- Rejected noncanonical configured origins with explicit default HTTP(S) ports.
- Added a failing HIGH/CRITICAL image scan, upgraded runtime OS packages, and removed unused package-installer tooling from the runtime image.
