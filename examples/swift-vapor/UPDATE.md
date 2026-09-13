# Update and rollback

This example supports updates only as an atomic repository change; independently mixing adapter, gateway, protocol, shared UI, or SDK revisions is unsupported.

1. Inventory `swift --version`, `swift package --version`, pinned dependencies in `Package.swift`/`Package.resolved`, Docker image digests in `Dockerfile`, `sdk/typescript/dist/version.json`, protocol fixtures, gateway package versions, and current deployment configuration. Preserve the prior image digest, source commit, lockfile, and external configuration/secret references.
2. Review Swift, Vapor, Vapor Redis, Async HTTP Client, Caddy, Redis, SDK, protocol, gateway, and base-image changelogs/deprecations plus security advisories. Validate Linux container and macOS local-tooling support before changing pins.
3. Keep mutable configuration and Redis data outside the source tree. If record compatibility can change, back up Redis through the deployment runbook. Never place credentials, cookies, session IDs, tickets, or private origins in commits, build context, or logs.
4. Update versions and digests together in `Package.swift`, `Package.resolved`, and `Dockerfile`, then run from `/home/runner/work/WebSockets-Kubernetes/WebSockets-Kubernetes/examples/swift-vapor`:

   ```text
   cp Package.resolved /tmp/Package.resolved
   swift package resolve --disable-sandbox
   diff -u /tmp/Package.resolved Package.resolved
   swift format lint --recursive --strict Sources Tests Package.swift
   swift test --disable-sandbox
   ```

   Rebuild canonical TypeScript assets from `/home/runner/work/WebSockets-Kubernetes/WebSockets-Kubernetes/sdk/typescript` using `npm ci --ignore-scripts && npm run build --silent`. Never copy shared assets or dependency sources into this directory.
5. Validate the candidate container and shared smoke scenarios:

   ```text
   docker build --file examples/swift-vapor/Dockerfile --tag cormier-swift-vapor:<candidate> .
   cd sdk/typescript
   npx playwright test --config playwright.swift-vapor.config.mjs
   ```

   Expected results: image build succeeds as non-root, `/health` returns healthy when Redis is reachable, `/api/diagnostics` reports `"stack":"Swift / Vapor"`, and login/ticket/connect/subscribe/publish/receive/reconnect/logout plus expiry/rejected-Origin/gateway-outage/shutdown scenarios behave as documented.
6. Deploy progressively with all network identities and secret values supplied externally. Monitor health, authentication/ticket failures, reconnect behavior, Redis availability, and shutdown signals. On failure, stop with a nonzero result, restore the previous image and configuration together, and repeat health/smoke verification.

The release check compares the previous supported commit and the candidate commit by running clean locked resolution, tests, image builds, and the same shared browser scenarios against both revisions before and after rollback. The initial `0.1.0` example has no earlier in-repository version, so this two-revision check begins with its first update.

## Deprecation policy

Routes, environment keys, runtime/dependencies, shared assets, protocol/gateway compatibility, and this example must not disappear silently. Announce deprecations in `README.md` and `CHANGELOG.md` before removal with replacement, migration, verification, rollback, and removal release/support window details.

There are no active deprecations. Changes to Redis record shape, the `cormier_session` cookie, Origin behavior, or ticket/WebSocket routes are coordinated breaking changes.

Implementing pull requests must record the exact validation commands they executed and their outcomes.
