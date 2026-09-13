# Update and deprecation procedure

1. Inventory Elixir/OTP/Mix, `mix.lock`, Hex advisories, image digest/platforms, SDK/version metadata, protocol fixtures, gateway packages, and deployment configuration. Preserve the prior image, lockfile, configuration/secret references, and external data.
2. Review Elixir, OTP, Phoenix, Bandit, Redix, Req, Mint.WebSocket, Alpine, SDK, gateway, and protocol changelogs, security notices, support policies, and deprecations; validate toolchain prerequisites first.
3. Update explicit versions and the base-image digest, run `mix deps.update <package ...>` for the reviewed dependency set, and inspect every `mix.lock` change. Run `mix deps.unlock --unused` only when intentionally removing an unused dependency. Never discard mutable configuration or Redis data during an application update.
4. Regenerate the canonical SDK and shared-web assets from one build, then run formatting, warning-denied compilation, tests, `mix hex.audit`, a clean release image build, `/health`, and the shared browser scenarios. Confirm rejected Origin, expiry, unavailable gateway, redacted failure, and SIGTERM supervision shutdown.
5. Deploy only after qualification. On failure restore the previous image and lock/configuration artifacts, verify health/browser behavior, and investigate through redacted structural events.

Do not silently remove routes, keys, dependencies, assets, runtime/framework support, protocol behavior, or this example. First document the replacement, migration and rollback, verification, and removal version or approved support window. CI verifies the current clean build; release qualification must also execute this procedure from the previous supported tag.
