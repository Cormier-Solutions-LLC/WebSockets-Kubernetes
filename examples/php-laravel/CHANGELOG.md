# Changelog

## Unreleased

- Production containers now use the centralized optimized web profile with deterministic hashes, SRI, and a readable rollback profile.

## 0.1.0

- Added the PHP 8.5 / Laravel 13 reference adapter with allowlisted example login, Redis-backed gateway-compatible session records, session inspection, logout, and redacted health/diagnostics.
- Added bounded ticket forwarding and a Caddy WebSocket upgrade route that preserves the original full Host authority, Origin, cookie, query, and subprotocol.
- Reused the canonical generated browser SDK, shared UI/CSS, configuration schema, protocol fixtures, and browser smoke scenarios without source copies.
- Added exact framework/client locks, dependency audit, formatting and unit/contract checks, a digest-pinned non-root image, preflight, update/rollback instructions, and explicit non-production limitations.
- Security and configuration: all origins, endpoints, ports, Redis prefixes, instance identity, allowlists, and secrets remain runtime-supplied; request logs are disabled and application failures are generic.
- Made the Caddy listener host runtime-supplied and rejected noncanonical configured origins with explicit default HTTP(S) ports.
- Rejected credentials, query strings, and fragments independently in origins, and made the Caddy public document root configurable for direct and container launches.
- Added a failing HIGH/CRITICAL image scan, upgraded runtime OS packages, and rebuilt the pinned FrankenPHP release with patched Go dependencies during image construction.
- Breaking changes, operator actions, and deprecations: none; this is the initial example release.
