# Update and rollback

Update this adapter atomically with the gateway, protocol fixtures, shared web assets, and SDK; mixed revisions are unsupported.

1. Inventory the current release inputs and rollback targets.
   - From `examples/rust-axum`, record `rustc --version`, `cargo --version`, `rust-toolchain.toml`, `Cargo.toml`, and `Cargo.lock`.
   - Record container base digests from `examples/rust-axum/Dockerfile` (`RUST_IMAGE` and `ALPINE_IMAGE`).
   - Record compatibility artifacts: `sdk/typescript/package.json`, `sdk/typescript/dist/version.json`, and `protocol/fixtures/v1/envelopes.json`.
   - Record deployment configuration and secret references only (never copy secret values into commits, tickets, or logs).
2. Validate prerequisites before changing pins.
   - Rust toolchain `1.98.1` with `rustfmt` and `clippy`.
   - Node/npm able to build `sdk/typescript/dist`.
   - Reachable Redis and gateway endpoints supplied through configuration, not hard-coded identities.
   - Previous image digest and commit available for rollback.
3. Apply coordinated updates in one change set.
   - Update together: `rust-toolchain.toml`, `Cargo.toml`, `Cargo.lock`, `examples/rust-axum/Dockerfile`, compatibility/version documentation, and any required SDK/protocol/gateway references.
   - Keep network locations, trust boundaries, and secrets externalized through environment/deployment configuration.
   - Do not mutate or migrate Redis data implicitly during application startup or install steps.
4. Verify from a clean checkout.
   - Build canonical browser assets from repository root:
     - `cd sdk/typescript`
     - `npm ci --ignore-scripts`
     - `npm run build --silent`
   - Validate the Rust adapter from `examples/rust-axum`:
     - `cargo fmt --check`
     - `cargo test --locked`
     - `cargo clippy --locked --all-targets -- -D warnings`
     - `cargo build --locked --release`
   - Build and scan the container from repository root:
     - `docker build --file examples/rust-axum/Dockerfile --tag cormier-rust-axum:<candidate> .`
     - Run the repository container vulnerability gate (HIGH/CRITICAL fail threshold).
   - Run shared browser smoke scenarios from `sdk/typescript`:
     - `npx playwright install --with-deps chromium`
     - `npx playwright test --config playwright.rust-axum.config.mjs`
   - Expected results: all commands exit `0`; `GET /health` returns `200` with `{"status":"healthy"}` when Redis is ready; rejected Origin, session expiry, gateway outage, logout, and graceful shutdown scenarios pass.
5. Deploy and rehearse rollback.
   - Deploy immutable image + mutable configuration/secrets.
   - On failure: stop with a nonzero result, restore the previous image/configuration/commit, restart, and re-run health and browser smoke checks.
   - Preserve only redacted structural evidence (no credentials, cookies, tickets, private origins, or internal addresses).

CI is a required gate for repository changes. Release qualification also requires recording previous/candidate commits, image digests, and rollback rehearsal results.

If this procedure changes, coordinate matching updates to sibling adapter update docs, README compatibility notes, and changelog text through the related documentation sub-issues so contradictory instructions are not left behind.

## Deprecation policy

Routes, configuration, runtime/dependencies, shared assets, protocol/gateway compatibility, and this example must not disappear silently. Each deprecation names the replacement, warning release, migration, security impact, verification, rollback, and removal version/window. The replacement comes first. Until another window exists, removal requires a breaking release and the previous repository version is the rollback target.

There are no active deprecations. Redis record shape, `cormier_session`, Origin behavior, and ticket/WebSocket routes are coordinated breaking changes.
