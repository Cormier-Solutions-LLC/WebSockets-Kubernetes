# Update and rollback

This example supports updates only as an atomic repository change; independently mixing adapter, gateway, protocol, shared UI, or SDK revisions is unsupported.

1. Inventory `java --version`, `./mvnw --version`, the exact parent/BOM/plugin versions in `pom.xml`, wrapper properties, Docker base digests, browser SDK/version metadata, protocol fixtures, gateway packages, and deployment configuration. Preserve the prior image digest, source commit, configuration/secret references, and external durable data.
2. Review Java, Maven, Spring Boot, Spring Cloud Gateway, Spring Data Redis, browser SDK, protocol, gateway, and base-image changelogs and deprecations. Validate Java, Redis, gateway, container tooling, shared-asset paths, required environment variables, and rollback artifacts before changing pins.
3. Update the pinned runtime, parent/BOM, wrapper/checksum, container digests, generated shared package/assets, gateway/protocol compatibility, and supported-version table together. Never migrate or overwrite Redis data as an implicit build or install step.
4. From a clean checkout, run `./mvnw verify`, build the repository SDK and this image, start against disposable Redis/gateway fixtures, wait only within the documented readiness bounds, and run the shared login/connect/subscribe/publish/receive/reconnect/expiry/rejected-Origin/gateway-outage/logout/shutdown scenarios.
5. Deploy the immutable candidate with mutable configuration supplied externally. If health or smoke verification fails, stop it with a meaningful nonzero result, restore the prior image/configuration/source revision, restart, and repeat health/smoke verification. Preserve only redacted failure evidence.

The release check compares the candidate with the previous supported commit by performing both clean wrapper builds, tests, image builds, health checks, and browser smoke scenarios. CI is the required repository check; a release operator must additionally record previous/candidate commits and image digests plus the rollback-rehearsal result.

## Deprecation policy

Routes, environment variables, dependency/runtime ranges, shared assets, protocol/gateway compatibility, and the example itself must not disappear silently. A deprecation entry must name the old behavior and replacement, first warning release, migration steps, verification and rollback commands, security impact, and removal version or approved support window. The replacement must exist before removal. Until a separate support window is published, removal may occur only in a documented breaking release and the immediately previous repository version is the rollback target.

There are no active deprecations. Changes to Redis record shape, the `cormier_session` cookie, Origin behavior, or ticket/WebSocket routes are breaking and require coordinated gateway migration and explicit changelog/operator actions.
