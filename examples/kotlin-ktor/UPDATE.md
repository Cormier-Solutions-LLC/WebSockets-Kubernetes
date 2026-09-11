# Update and rollback

Update this adapter, gateway, protocol, shared UI, and SDK atomically; mixing revisions independently is unsupported.

1. Inventory `java --version`, `./gradlew --version`, plugin/module versions, `gradle.lockfile`, wrapper properties/checksum, container digests, SDK metadata, protocol fixtures, gateway packages, and deployment configuration. Preserve the prior image digest, commit, configuration references, and external data.
2. Review Java, Kotlin, Ktor, Gradle, Lettuce, browser SDK, protocol, gateway, and base-image changelogs/deprecations. Validate the runtime, Redis, gateway, container tooling, asset paths, environment variables, and rollback artifacts.
3. Update runtime/compiler/framework pins, wrapper/checksum, lockfile, container digests, shared package/assets, gateway/protocol compatibility, and version table together. Regenerate locks only with `./gradlew dependencies --write-locks`; never migrate Redis data implicitly.
4. From a clean checkout, run `./gradlew test`, `./gradlew buildFatJar`, build the SDK and image, start disposable Redis/gateway fixtures, and run bounded health plus shared login/connect/subscribe/publish/receive/reconnect/expiry/rejected-Origin/gateway-outage/logout/shutdown checks.
5. Deploy the immutable candidate with external configuration. On failed health/smoke checks, stop with nonzero status, restore the prior image/configuration/commit, restart, and repeat verification. Preserve only redacted evidence.

The release check compares candidate and previous supported commits through clean locked builds, tests, images, health checks, browser scenarios, and a rollback rehearsal. CI is mandatory; the operator additionally records both commits/image digests and the rehearsal result.

## Deprecation policy

Routes, configuration, dependency/runtime ranges, shared assets, protocol/gateway compatibility, and this example must not disappear silently. Each deprecation names the old behavior/replacement, first warning release, migration and verification, security impact, rollback, and removal version or approved window. The replacement must exist first. Until another window is published, removal requires a documented breaking release and the immediately previous repository version remains the rollback target.

There are no active deprecations. Redis record shape, `cormier_session`, Origin behavior, and ticket/WebSocket routes are coordinated breaking changes.
