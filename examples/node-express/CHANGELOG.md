# Changelog

## 1.0.3-beta - 2026-09-25

- See the coordinated release notes in `docs/release-notes/1.0.3-beta.md`.

## 1.0.2-beta - 2026-09-24

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.
- Current operational clarification: the WebSocket drain deadline is 15 seconds and the forced-exit timer is 16 seconds. `/health` checks Redis only; Express middleware (including the process-local limiter) does not process WebSocket upgrades, so gateway authentication, Origin checks and connection limits remain essential.
- Build the SDK and shared UI together before packaging; see [README.md](README.md) and [UPDATE.md](UPDATE.md) for asset generation, container networking and rollback. The initial release entry below is preserved.

## 0.1.0

- Added a bounded process-local request limiter; production deployments still require a distributed abuse-control store and policy.
- Fixed upgraded-socket cleanup during proxy failures and graceful shutdown.
- Made the listener address explicit, bounded ticket proxy requests, and added an exact trusted-proxy hop setting so HTTPS deployments emit Secure cookies without trusting arbitrary forwarding headers.
- Rejected configured HTTP(S) origins that spell out the scheme's default port, matching browser Origin serialization.
- Added a failing HIGH/CRITICAL image scan, upgraded runtime OS packages during image construction, and removed build-only npm tooling from the runtime image.
- Added the Node.js 24/Express 5 reference adapter with validated environment-only network configuration.
- Added same-origin login/logout, gateway-compatible Redis sessions, ticket and WebSocket forwarding, readiness, graceful shutdown, and redacted structural failures.
- Reused the canonical shared browser UI and generated Cormier.Realtime 0.1.0 SDK; no stack-specific asset copy is maintained.
- Added locked dependencies, tests, a digest-pinned container path, feature/support matrices, and update/rollback/deprecation guidance.
- Security/operator action: replace the fixture secret and all fixture network settings, configure the gateway's trusted Origin and matching Redis prefixes, and supply the production controls explicitly listed as omitted.

No prior supported Node/Express example exists, so this initial version has no migration or deprecated behavior.
