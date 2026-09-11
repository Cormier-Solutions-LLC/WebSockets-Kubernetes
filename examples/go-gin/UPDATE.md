# Update and deprecation procedure

1. Inventory `go version`, all direct and indirect modules (`go list -m all`), Docker base digests, SDK/version metadata, protocol fixtures, gateway packages, and deployment configuration. Preserve the previous image digest, `go.mod`, `go.sum`, configuration/secret references, and external durable data.
2. Review Go, Gin, go-redis, coder/websocket, Alpine, SDK, gateway, and protocol changelogs, security notices, support policies, and deprecations. Confirm Go and module prerequisites before editing pins.
3. Update explicit versions and base digests, run `go mod tidy`, review both module-file diffs, and never discard mutable configuration or Redis data as part of an application update.
4. Run formatting, tests, vet, a clean container build, `/health`, and the shared browser scenarios. Confirm rejected Origin, expiry, unavailable gateway, redacted failure, and SIGTERM shutdown behavior.
5. Deploy only after the prior checks pass. On failure, restore the previous image and configuration/module lock artifacts, verify health and browser behavior, and investigate with redacted structural logs.

Do not silently remove a route, configuration key, dependency, shared asset, runtime/framework version, protocol behavior, or this example. First add a changelog warning naming the replacement, migration and rollback steps, verification, and a removal version or approved support window. Keep the old behavior through that window. CI verifies the current clean build; release qualification must also execute this procedure from the previous supported tag.
