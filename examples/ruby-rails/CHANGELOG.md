# Changelog

## 0.1.0

- Added the Ruby 4.0 / Rails 8.1 reference adapter with strict settings, allowlisted login, encrypted Rails session state, Redis-backed gateway-compatible sessions, logout, and redacted health/diagnostics.
- Added bounded HTTP ticket forwarding and Caddy WebSocket relay while preserving browser authority, Origin, cookie, and protocol.
- Reused canonical generated browser assets, UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact locked gems, RuboCop/Minitest/Brakeman/bundler-audit gates, digest-pinned non-root image, supervised lifecycle behavior, update/rollback instructions, and non-production limitations.
- Pinned JSON 2.21.2 because Rails 8.1.3.1 request decoding is not compatible with the JSON 3.0 positional-options API.
- Security and configuration: every network identity and Redis/session prefix remains runtime-supplied; errors/logs are generic and dependency access logging is suppressed.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
