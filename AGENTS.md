# Repository agent guidance

## Product identity

- Use `Cormier` for the distributable brand and `Cormier.Realtime` for .NET solution, project, namespace, assembly, and package identities.
- Treat customer, tenant, environment, and deployment suffixes as configuration. Never encode a customer-specific or legacy brand in source-controlled identifiers.
- Derive deployable identities through the shared bootstrap configuration and `-NameSuffix` / `--name-suffix` override. Consume `.bootstrap/naming.json` where automation needs those derived names; its Redis prefix already includes the environment. The generated file is local and must not be committed.

## Environment-specific configuration

- Every domain, origin, host/server name, IP address, CIDR, port, external endpoint, Kubernetes context, namespace, release name, image registry/repository, and Secret name must be supplied through configuration, deployment values, parameters, environment variables, or test fixtures.
- Do not add environment-specific network identities to application code. Option classes may define protocol-neutral behavior defaults, but network locations and trust boundaries belong in `appsettings*.json`, Helm values, deployment parameters, or environment variables.
- Keep production values out of the repository. Values committed under examples, development settings, or tests must use loopback, RFC-reserved documentation names/addresses, or unmistakable placeholders and must remain overridable.
- Never commit credentials, tokens, private keys, or rendered Secrets. Reference an existing Secret and configurable key names.

## Repository boundaries

- Keep protocol envelopes, routes, and serialization contracts in `src/Cormier.Realtime.Contracts`; hosting integration in `src/Cormier.Realtime.AspNetCore`; Redis adapters in `src/Cormier.Realtime.Redis`; and the executable host in `src/Cormier.Realtime.Gateway`. Client libraries and browser asset packaging have separate projects and package READMEs.
- Preserve declared target frameworks and bounded dependency ranges. Read `global.json`, project files, lockfiles, and `sdk/typescript/package.json` for current toolchain requirements rather than copying version numbers into new guidance. Preserve source-generated serialization and Native AOT compatibility when changing gateway or contract code.
- Treat `sdk/typescript` as the browser client source and `examples/shared-web` as the shared example UI. Generate browser artifacts with `npm --prefix sdk/typescript ci` followed by `npm --prefix sdk/typescript run build`; do not hand-edit generated bundles. The browser NuGet package packages SDK assets, not the shared example UI.
- Implement new bootstrap lifecycle behavior in the shared Node.js engine with equivalent PowerShell and Bash wrappers. `Bootstrap-Realtime.ps1` and `Deploy-Realtime.ps1` are legacy compatibility entry points with different parameter contracts. Follow [scripts guidance](scripts/README.md) and the [bootstrap guide](docs/bootstrap.md).
- Keep session provisioning, ticket issuance/consumption, and route authorization distinct. A sample login or a serialized envelope does not establish a production authentication or authorization policy. Verify security claims against the relevant host, validator, and store implementation.
- Preserve historical changelog entries and reference snapshots. Explain current differences explicitly; historical material under `refs` is not evidence of current runtime defaults. Use Cormier terminology in current distributable content.

## Validation and completion

- Match validation to the changed surface and record what actually ran, its outcome, and any unavailable prerequisites. Use [.github/workflows/ci.yml](.github/workflows/ci.yml) for executable validation recipes; do not claim a source inspection exercised runtime behavior.
- For documentation-only changes, read the whole target document, compare claims with source/configuration/tests/package metadata, check commands and links, and run `git diff --check`. Coordinate related corrections within the authorized ticket scope. A documentation audit alone does not require deployment, package publication, or the entire runtime suite.
- For .NET behavior changes, use locked restore, Release build and relevant tests; provide a disposable configured Redis endpoint for integration tests. Validate Native AOT publication when changing the gateway, serialization, dependencies, or trimming-sensitive paths. Build before using test commands with `--no-build`.
- For SDK changes, run `npm --prefix sdk/typescript ci` and `npm --prefix sdk/typescript run check`. Browser integration tests additionally require Playwright engines, a built Release gateway and configured Redis; follow the [SDK README](sdk/typescript/README.md). Check generated artifact reproducibility.
- For bootstrap or naming/configuration changes, update contract tests and check cross-shell parity in `tests/bootstrap`. Parse PowerShell, check Bash syntax/static analysis, and render/lint affected Helm configurations. Cover both `ha` and `non-ha` topology contracts when affected; run applicable security checks for trust-boundary changes.
- For package changes, use the relevant clean-consumer checks and [package release policy](docs/package-release.md). Build/validation is separate from promotion; preserve verified candidate bytes when publishing.
- Inspect the final diff and staged files. Keep generated plans, logs, backups, evidence, credentials and environment configuration out of commits; ignored directories are not a secret-sanitization mechanism. Report validation limitations without silently expanding a documentation task into code or infrastructure changes.
