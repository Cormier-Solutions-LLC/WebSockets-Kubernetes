# Update and rollback

Update the adapter, gateway, protocol, shared UI, and SDK atomically; mixed revisions are unsupported.

1. Inventory `rustc --version`, `cargo --version`, toolchain/dependency pins, `Cargo.lock`, container digests, SDK/protocol/gateway versions, and deployment configuration. Preserve the prior image, commit, configuration references, and data.
2. Review Rust, Axum, Tokio, Redis client, TLS, SDK, protocol, gateway, and base-image changelogs/deprecations. Validate prerequisites and rollback artifacts.
3. Update the toolchain, manifest, lockfile, image digests, shared assets, gateway/protocol compatibility, and version table together. Never mutate Redis data implicitly.
4. From a clean checkout, run format, locked tests, warning-as-error Clippy, locked release/image builds, bounded health, and shared browser expiry/Origin/outage/logout/shutdown scenarios.
5. Deploy the immutable candidate with external configuration. On failure, stop nonzero, restore the prior image/configuration/commit, restart, and repeat verification; retain only redacted evidence.

The release check compares previous and candidate commits through clean locked builds, tests, images, browser scenarios, and rollback rehearsal. CI is mandatory; operators record commits, image digests, and rehearsal result.

## Deprecation policy

Routes, configuration, runtime/dependencies, shared assets, protocol/gateway compatibility, and this example must not disappear silently. Each deprecation names the replacement, warning release, migration, security impact, verification, rollback, and removal version/window. The replacement comes first. Until another window exists, removal requires a breaking release and the previous repository version is the rollback target.

There are no active deprecations. Redis record shape, `cormier_session`, Origin behavior, and ticket/WebSocket routes are coordinated breaking changes.
