# Changelog

## 1.0.3-beta - 2026-09-25

- See the coordinated release notes in `docs/release-notes/1.0.3-beta.md`.

## 1.0.2-beta - 2026-09-24

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.
- `HEARTBEAT_INTERVAL_MILLISECONDS` is now required and `/api/diagnostics` publishes it for the shared browser client; set it to the gateway heartbeat in seconds multiplied by 1000.

## 0.1.0

- Added the Ruby 4.0.6 / Rails 8.1.3.1 reference adapter for Cormier.Realtime with strict settings, allowlisted login, encrypted Rails session state, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded HTTP ticket forwarding and Caddy WebSocket relay while preserving browser authority, Origin, cookie, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact locked gems, RuboCop/Minitest/Brakeman/bundler-audit gates, digest-pinned non-root image, supervised lifecycle behavior, update/rollback instructions, and non-production limitations.
- Pinned JSON 2.21.2 because Rails 8.1.3.1 request decoding is not compatible with the JSON 3.0 positional-options API.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Made the Caddy listener host runtime-supplied and rejected noncanonical configured origins with explicit default HTTP(S) ports.
- Added a failing HIGH/CRITICAL image scan, upgraded runtime OS packages, pinned the patched resolver gem, and built Caddy with patched Go dependencies.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
