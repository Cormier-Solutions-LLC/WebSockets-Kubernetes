# Package release policy

Cormier.Realtime produces five NuGet packages and one optional npm package from one immutable release candidate:

| Artifact | Version property | Purpose |
| --- | --- | --- |
| `Cormier.Realtime.Contracts` | `ContractsVersion` | Protocol DTOs and validation for .NET Standard 2.0 and .NET 10 |
| `Cormier.Realtime.Client` | `DotNetClientVersion` | Runtime-neutral .NET Standard WebSocket client |
| `Cormier.Realtime.Redis` | `RedisAdapterVersion` | Redis messaging, session, and ticket infrastructure |
| `Cormier.Realtime.AspNetCore` | `AspNetCoreIntegrationVersion` | ASP.NET Core hosting integration |
| `Cormier.Realtime.Browser` | `BrowserPackageVersion` | Razor static web assets generated from the browser SDK |
| `@cormier/realtime` | `sdk/typescript/package.json` | Optional npm form of the same browser SDK; publication requires registry-owner approval |

The NuGet IDs are the supported public identities. The npm name is a candidate identity and the release workflow does not publish it unless an approved registry and npm token are supplied explicitly. Package IDs, versions, and registry endpoints are release configuration; no customer or deployment name is part of an artifact identity.

## Versioning and compatibility

Each artifact owns its semantic version. A breaking public API or protocol-support change increments its major version; an additive feature increments minor; a compatible correction increments patch. Prerelease labels identify candidates. Build metadata may carry an immutable source revision but is ignored when calculating compatibility ceilings and normalized out of NuGet filenames.

Internal NuGet dependencies use `[current,next-minor)` ranges. Contracts remain the protocol authority: client, Redis, and ASP.NET packages must not be promoted unless their supported Contracts range contains the exact Contracts artifact in the same candidate. Browser and npm artifacts record the wire protocol and subprotocol in `version.json`. Coordinated release is required when a consumer's existing range would exclude a changed dependency or when protocol compatibility changes.

Deprecated APIs remain for at least one minor release unless a security correction requires faster removal. Deprecation, migration, and the planned removal version belong in release notes. Package versions are immutable: never overwrite a published version.

## Build and inspect locally

Use PowerShell 7 and supply network identities as configuration:

```powershell
./scripts/Build-RealtimePackages.ps1 `
  -UpstreamPackageSource $env:NUGET_UPSTREAM_SOURCE `
  -RedisTestEndpoint $env:REDIS_TEST_ENDPOINT
```

The workflow restores locked dependencies, builds, tests, creates browser outputs, packs all artifacts into isolated staging, inspects intended assets and dependency bounds, installs packages into clean consumers, checks reproducibility, and writes SHA-256 and manifest evidence. `-WhatIf` prints the plan without running tools or changing output. A repeated build is `UNCHANGED` only when every artifact hash matches; a different artifact with the same version fails as a version conflict.

## Promotion and publication

CI uploads the candidate named for the source commit. Promotion downloads that exact artifact rather than rebuilding. Its manifest is deterministic for a given clean commit and artifact set, so a later build of the same candidate retains the same resume identity. Promotion verifies the manifest and checksum file before any push, validates every selected registry credential before mutation, requires the exact commit to have successful main-branch CI, uses an environment approval gate restricted to the main branch, serializes promotion runs for each candidate, publishes NuGet packages in dependency order, and records each package and symbol-package upload independently so an interrupted run can resume at the next unrecorded artifact. The protected `package-production` environment owns the `NUGET_SOURCE` and optional `NPM_REGISTRY` variables; dispatch callers cannot override the endpoints that receive release credentials. Stable npm versions, including versions with build metadata, use the `latest` distribution tag; prerelease versions use `next`. Resume state is bound to the exact manifest hash and a canonical, path-case-sensitive registry identity. An unproven duplicate reported by a registry fails the run; it is never silently skipped. Tokens are accepted only through secret-backed environment variables and are never printed; the temporary npm configuration is owner-only on Unix hosts.

NuGet publication uses `Publish-RealtimePackages.ps1 -NuGetSource <configured source>`. Add `-PublishNpm` only after ownership of the configured npm registry/name is approved. Use `-WhatIf` to rehearse commands without credentials or network mutation. Signing remains disabled until a signing identity and trust policy are approved; provenance attestations and SBOMs are produced by CI for the immutable candidate.

Rollback never replaces package bytes. Deprecate the bad immutable version in the registry, publish a corrected patch, restore the previous compatible version range in consumers, and retain the failed candidate, checksums, manifest, scan results, SBOM, provenance, release notes, and redacted logs for audit. If publication partially fails, start a new dispatch for the same commit and supply the failed workflow's `resume_run_id`; the workflow validates and restores its retained promotion state. Only pushes already recorded for that exact manifest—and, for npm, the same registry—are skipped. Without that evidence, a duplicate-version response stops the run for operator verification.

## Consumer paths

- ASP.NET Core: install `Cormier.Realtime.AspNetCore`; configure Redis and realtime options at runtime.
- .NET Standard: install `Cormier.Realtime.Client`; it contains no ASP.NET Core dependency.
- Browser through NuGet: install `Cormier.Realtime.Browser` and load `/_content/Cormier.Realtime.Browser/cormier-realtime.iife.min.js` or the ESM equivalent.
- Raw JavaScript: use the inspected npm tarball, or extract the same files from the candidate's `Cormier.Realtime.Browser` NuGet package under `staticwebassets/`.

If restore fails, confirm the configured feed contains every dependency version in the recorded ranges and that no package source mapping excludes the local/test feed. For static assets, confirm `UseStaticFiles` is enabled and inspect the generated `staticwebassets.*.json` manifest. For duplicate-version errors, compare the candidate checksum with retained promotion evidence; never use `--skip-duplicate` as proof that bytes match.
