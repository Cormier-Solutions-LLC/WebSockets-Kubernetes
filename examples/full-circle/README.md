# Cormier.Realtime full-circle application

This application is an external-consumer proof for the supported ASP.NET Core integration and generated browser SDK. It creates an ASP.NET Core session, stores the authoritative tenant/user identity in Redis, issues a single-use connection ticket, maps the realtime endpoints, and exposes direct-script and ESM browser workflows.

The `/operator.html` page demonstrates the operator-only diagnostics workflow against a diagnostics API that has been explicitly enabled and protected. Supply the configured base path and a short-lived operator bearer token at runtime; the page keeps it only in memory and never writes it to output or storage. Snapshot, operational-event, live-log, and temporary log-level control calls remain subject to the server's policy, Origin, network, duration, buffer, and rate limits. The ordinary application page does not expose these controls.

In Development, the application enables the loopback-only operator workflow and creates a 256-bit token at `.bootstrap/full-circle/operator-token` when no `Diagnostics__OperatorToken` is supplied. Startup logs show this file path but never the credential. Read the ignored file locally and paste its value into `/operator.html`; deleting the file rotates the generated token on the next start. A token supplied through configuration remains configuration-only and is not copied to disk.

## Prerequisites

- .NET SDK 10
- Node.js 22 or later and npm
- PowerShell 7 or Bash
- Docker with Docker Compose for the automatically managed local Redis dependency
- Chromium for browser validation (`npx playwright install chromium` from `sdk/typescript`)

With no `REDIS_TEST_ENDPOINT`, the lifecycle starts the pinned Redis 7 image from `compose.yaml`, publishes it only on `127.0.0.1:16379`, waits for its health check, and configures the web process to use it. Set `FULL_CIRCLE_REDIS_IMAGE` or `FULL_CIRCLE_REDIS_PORT` to override the local container without editing the Compose file. When launching directly from an IDE with a custom port, override `Redis__Endpoint` there as well. Set `REDIS_TEST_ENDPOINT` to use an already managed Redis endpoint instead; doing so disables automatic container deployment and teardown.

No credentials are embedded. Set `NUGET_UPSTREAM_SOURCE` when the default is unsuitable. Redis authentication and topology use the normal environment-backed configuration keys: `Redis__User`, `Redis__Password`, `Redis__Ssl`, `Redis__SentinelServiceName`, and `Redis__SentinelPassword`. Secrets remain in environment variables and are never placed in command arguments or logs.

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

`bootstrap` deploys and verifies the local dependency stack when an external Redis endpoint was not supplied, restores and builds the project-reference development graph, then packs the libraries into an isolated local feed and builds the same application using only NuGet package references. Candidate packages use a fresh package cache and exclusive local source mapping. The committed consumer graph pins upstream hashes; bootstrap adds the freshly packed local package hashes to an ignored copy and restores that complete graph in locked mode. A missing browser static-asset route fails bootstrap. `validate` also ensures the dependency stack is running before executing bounded Playwright scenarios. `cleanup` deletes only the configured literal test prefix in Redis, removes the repository's `artifacts/full-circle` directory, and tears down only the Compose stack it manages. Repeating bootstrap, validation, or cleanup is supported.

Launching **Example: Full Circle** from VS Code performs the same Compose deployment before starting the web project. The VS Code launch configuration supplies `Redis__Endpoint=127.0.0.1:16379`; use the **dependencies: full-circle (stop)** task when you want to stop the persistent development container without running lifecycle cleanup.

The `non-ha` profile starts one process and makes no failover promise. The `ha` profile starts two processes behind the test proxy and verifies Redis fan-out, tenant isolation, a forced transport drop, ticket reauthentication, subscription restoration, and reconnect to a different instance. The UI reports the selected topology, instance, Redis readiness, connection state, structured errors, and received events.

The base configuration uses a 15-second heartbeat and a 45-second idle timeout for deployed Test and Production environments. Development and the dedicated Automation environment use 5- and 15-second values. The UI reads `heartbeatIntervalMilliseconds` from `/api/diagnostics` before connecting, so its client heartbeat always matches the active server profile.

Release builds embed the centralized `shared-web/dist/optimized` profile, including SRI-bound minified assets. Non-Release development embeds the readable canonical source. The containerized reference stacks make the same production selection through `SHARED_ASSET_ROOT`; see [optimized-assets.md](../../docs/optimized-assets.md) for explicit obfuscation, source-map handling, support diagnosis, and rollback.

`run` starts the first planned instance for interactive diagnosis. For the complete two-instance HA topology, use `validate`; it owns and tears down every process deterministically. `update` and `recover` rerun the idempotent bootstrap. `rollback` removes only generated fixtures and evidence, matching cleanup.

## Expected results and evidence

A successful action ends with a JSON `pass` record and writes a redacted summary under `artifacts/full-circle`. On browser failure, screenshots, video, trace, and the HTML report remain there and CI uploads them. Logs include configured topology and instance names but omit session IDs, tickets, cookies, Redis endpoints, and credentials.

The suite covers anonymous login rejection, configured tenant/user login, ticket authentication, direct-script and ESM assets, connect/disconnect, subscribe/unsubscribe, publish/receive, invalid routes and payloads, tenant isolation, Redis-backed fan-out, and HA reconnect. Existing solution integration/browser tests cover expired and reused tickets, rejected Origin, oversized/fragmented messages, slow consumers, queue saturation, Redis interruption/recovery, and graceful shutdown/drain. The .NET Standard SDK package-consumer path remains verified by `scripts/Test-DotNetClientPackage.ps1` in the main build job.

## Troubleshooting and limits

- `Redis unavailable`: verify Docker is running, or verify `REDIS_TEST_ENDPOINT`, network access, and configured Redis authentication when using an external endpoint, then run `recover`.
- `browser executable missing`: install Chromium from `sdk/typescript`.
- `invalid Origin`: make `Realtime__AllowedOrigins__0` exactly match the configured entry origin; do not use wildcards.
- Port conflict: change the versioned plan before bootstrap so both shells use the same topology.
- A non-HA run cannot prove replica failover. HA is a local process topology, not a production availability claim.

Configuration changes are confined to ignored artifacts, so there is no data backup step. Before changing the shared plan, preserve its prior committed version; `git diff examples/full-circle/full-circle.plan.json` is the topology-change preview and reverting that file is the rollback. Support follows the repository release policy. Deprecated plan fields require a schema-version change and a documented migration.
