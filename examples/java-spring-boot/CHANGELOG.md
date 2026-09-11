# Changelog

Operator-visible changes to the Java/Spring Boot reference application are recorded here. Entries identify features, fixes, security/configuration impact, breaking behavior, and required operator action.

## 0.1.0 - 2026-09-11

### Added

- Minimal reactive Spring Boot adapter with validated external configuration, allowlisted demonstration login, Redis-backed gateway-compatible sessions, logout, dependency-aware health, and redacted diagnostics.
- Spring Cloud Gateway forwarding for connection tickets and WebSocket upgrades with Host preservation and same-origin ticket enforcement.
- Direct hosting of canonical shared UI/CSS and generated browser SDK, plus shared browser scenarios and protocol/configuration contract tests.
- Digest-pinned, non-root multi-stage container and checksum-pinned Maven 3.9.12 wrapper.

### Security and configuration

- No environment endpoint, credential, identity, session, or ticket is built into source or the image.
- Session cookies are HTTP-only, SameSite Strict, path-scoped, and Secure when `PUBLIC_ORIGIN` uses HTTPS.
- API responses are non-cacheable and all responses receive restrictive browser security headers.
- The listener address is runtime-supplied, and configured origins with explicit default HTTP(S) ports are rejected to match browser Origin serialization.
- Added a failing HIGH/CRITICAL image scan and upgraded runtime OS packages during image construction.

### Limitations and operator actions

- This demonstration omits production identity, authorization, CSRF/abuse controls, TLS, secret management, telemetry, and orchestration. Supply those externally before adapting it for production.
- Configure the gateway and this adapter with the same Redis namespace and trusted public origin. Build the canonical browser SDK before local startup or the container build.

No breaking changes, fixes, or active deprecations exist in the initial release.
