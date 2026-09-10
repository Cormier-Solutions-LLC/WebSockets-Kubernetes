# Cormier.Realtime full-circle application

This application is an external-consumer proof for the supported ASP.NET Core integration and generated browser SDK. It creates an ASP.NET Core session, stores the authoritative tenant/user identity in Redis, issues a single-use connection ticket, maps the realtime endpoints, and exposes direct-script and ESM browser workflows.

## Prerequisites

- .NET SDK 10
- Node.js 22 or later and npm
- PowerShell 7 or Bash
- Chromium for browser validation (`npx playwright install chromium` from `sdk/typescript`)
- A configured Redis 7 endpoint; local examples use the loopback-only `127.0.0.1:6379`

No credentials are embedded. Set `REDIS_TEST_ENDPOINT` and `NUGET_UPSTREAM_SOURCE` when the defaults are unsuitable. Redis authentication is supplied through the normal `Redis` configuration surface.

## Shared lifecycle

Both shell entry points call `scripts/full-circle.mjs`, which reads the versioned `full-circle.plan.json`. A profile is always explicit:

```powershell
./scripts/FullCircle.ps1 -Action plan -Profile non-ha -DryRun
./scripts/FullCircle.ps1 -Action bootstrap -Profile ha
./scripts/FullCircle.ps1 -Action validate -Profile ha
./scripts/FullCircle.ps1 -Action cleanup -Profile ha
```

```bash
bash ./scripts/full-circle.sh plan --profile non-ha --dry-run
bash ./scripts/full-circle.sh bootstrap --profile ha
bash ./scripts/full-circle.sh validate --profile ha
bash ./scripts/full-circle.sh cleanup --profile ha
```

`bootstrap` restores and builds the project-reference development graph, then packs the libraries into an isolated local feed and builds the same application using only NuGet package references. Candidate packages use a fixed validation-only revision, deterministic archive metadata, a fresh package cache, exclusive local source mapping, and the committed lock for the current operating system. A missing browser static-asset route fails bootstrap. `validate` runs bounded Playwright scenarios. `cleanup` deletes only the configured literal test prefix in Redis and the repository's `artifacts/full-circle` directory. Repeating bootstrap, validation, or cleanup is supported.

The `non-ha` profile starts one process and makes no failover promise. The `ha` profile starts two processes behind the test proxy and verifies Redis fan-out, tenant isolation, a forced transport drop, ticket reauthentication, subscription restoration, and reconnect to a different instance. The UI reports the selected topology, instance, Redis readiness, connection state, structured errors, and received events.

`run` starts the first planned instance for interactive diagnosis. For the complete two-instance HA topology, use `validate`; it owns and tears down every process deterministically. `update` and `recover` rerun the idempotent bootstrap. `rollback` removes only generated fixtures and evidence, matching cleanup.

## Expected results and evidence

A successful action ends with a JSON `pass` record and writes a redacted summary under `artifacts/full-circle`. On browser failure, screenshots, video, trace, and the HTML report remain there and CI uploads them. Logs include configured topology and instance names but omit session IDs, tickets, cookies, Redis endpoints, and credentials.

The suite covers anonymous login rejection, configured tenant/user login, ticket authentication, direct-script and ESM assets, connect/disconnect, subscribe/unsubscribe, publish/receive, invalid routes and payloads, tenant isolation, Redis-backed fan-out, and HA reconnect. Existing solution integration/browser tests cover expired and reused tickets, rejected Origin, oversized/fragmented messages, slow consumers, queue saturation, Redis interruption/recovery, and graceful shutdown/drain. The .NET Standard SDK package-consumer path remains verified by `scripts/Test-DotNetClientPackage.ps1` in the main build job.

## Troubleshooting and limits

- `Redis unavailable`: verify `REDIS_TEST_ENDPOINT`, network access, and configured Redis authentication, then run `recover`.
- `browser executable missing`: install Chromium from `sdk/typescript`.
- `invalid Origin`: make `Realtime__AllowedOrigins__0` exactly match the configured entry origin; do not use wildcards.
- Port conflict: change the versioned plan before bootstrap so both shells use the same topology.
- A non-HA run cannot prove replica failover. HA is a local process topology, not a production availability claim.

Configuration changes are confined to ignored artifacts, so there is no data backup step. Before changing the shared plan, preserve its prior committed version; `git diff examples/full-circle/full-circle.plan.json` is the topology-change preview and reverting that file is the rollback. Support follows the repository release policy. Deprecated plan fields require a schema-version change and a documented migration.
