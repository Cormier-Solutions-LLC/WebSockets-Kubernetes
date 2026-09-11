# Update and rollback

This example supports updates only as an atomic repository change; independently mixing adapter, gateway, protocol, shared UI, or SDK revisions is unsupported.

1. Inventory `node --version`, `npm --version`, the exact dependencies in `package.json`/`package-lock.json`, the Docker base digest, `sdk/typescript/package.json`, `sdk/typescript/dist/version.json`, protocol fixtures, gateway package versions, and current deployment configuration. Preserve the prior image digest, lockfiles, configuration/secret references, and any external durable data.
2. Review Node, Express, middleware, Redis-client, browser-SDK, protocol, gateway, and base-image changelogs and deprecations. Validate Node/npm, Redis, gateway, container tooling, shared-asset paths, required environment variables, and available rollback artifacts before changing pins.
3. Update the pinned runtime, dependencies, generated shared package/assets, gateway/protocol compatibility, lockfile, and supported-version table together. Never migrate or overwrite Redis data as an implicit install step.
4. From clean installs, run `npm ci && npm run check`, build the repository SDK, build this image, start against disposable Redis/gateway fixtures, wait no more than the documented readiness bound, and verify health plus the shared login/connect/subscribe/publish/receive/reconnect/expiry/rejected-Origin/gateway-outage/logout/shutdown browser scenarios.
5. Deploy the immutable candidate with mutable configuration and secrets supplied externally. If health or smoke verification fails, stop it with a meaningful nonzero result, restore the prior image/configuration/lockfiles, restart, and repeat health/smoke verification. Preserve redacted failure evidence.

The release check compares a candidate with the previous supported commit by performing both clean locked installs, tests, image builds, and smoke scenarios. CI is the required check for repository changes; a release operator must additionally record the previous/candidate commits and image digests and the rollback rehearsal result.

## Deprecation policy

Routes, environment variables, dependency/runtime ranges, shared assets, protocol/gateway compatibility, and the example itself must not disappear silently. A deprecation entry must name the old behavior and replacement, first warning release, migration steps, verification and rollback commands, security impact, and removal version or approved support window. The replacement must be available before removal. Until the project publishes a separate support window, removal may occur only in a documented breaking release and the immediately previous repository version is the rollback target.

There are no active deprecations. Changes to Redis record shape, cookie names, Origin behavior, or ticket/WebSocket routes are breaking and require coordinated gateway migration and explicit changelog/operator actions.
