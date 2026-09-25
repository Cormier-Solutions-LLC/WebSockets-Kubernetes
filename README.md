# Cormier Realtime Gateway

Cormier Realtime Gateway is an independently deployable .NET 10 Native AOT foundation for the Cormier realtime WebSocket platform. It can run as a standalone gateway or be embedded in an existing ASP.NET Core application through the reusable hosting package.

The repository also contains the shared protocol contracts, Redis integration, .NET and browser clients, Kubernetes and Helm deployment assets, cross-platform lifecycle automation, observability assets, load tooling, and reference applications used to verify the platform end to end.

## Repository map

- `src/Cormier.Realtime.Gateway` — standalone Native AOT ASP.NET Core gateway host.
- `src/Cormier.Realtime.AspNetCore` — reusable hosting, endpoint, diagnostics, and session integration.
- `src/Cormier.Realtime.Contracts` — source-generated JSON wire contracts targeting .NET 10 and .NET Standard 2.0.
- `src/Cormier.Realtime.Redis` — Redis session, ticket, pub/sub, and optional durable-stream integration.
- `src/Cormier.Realtime.Client` — runtime-neutral .NET Standard 2.0 WebSocket client.
- `src/Cormier.Realtime.Browser` and `sdk/typescript` — NuGet-packaged browser assets and the canonical TypeScript/npm client.
- `protocol/fixtures` — language-neutral protocol and compatibility fixtures.
- `examples` — .NET consumers, browser assets, a full-circle test application, and ten alternative web-stack adapters.
- `bootstrap`, `scripts`, `helm`, and `cluster` — versioned lifecycle configuration, cross-shell automation, chart, and cluster assets.
- `observability` and `load` — portable telemetry contracts, dashboards and alerts, failure exercises, and load tooling.
- `tests` and `tools` — .NET verification projects and the load runner.
- `docs` — architecture, protocol, bootstrap, SDK, release, developer, and operator guidance.
- `refs` — historical source material and the governing scripting standard.

## Prerequisites

The pinned development SDK is .NET `10.0.303` with roll-forward to a compatible .NET 10 feature band. Node.js 22 or later is required for the bootstrap engine and TypeScript SDK. PowerShell 7 is supported on Windows, Linux, and macOS; the Bash wrapper requires Bash 5 or later on Linux or macOS. Native AOT publishing also requires the platform compiler toolchain.

Git is required by the lifecycle automation. Docker is optional for normal builds and required for local OCI runtime verification and the documented Redis fixture. Cluster operations additionally require the tools and access described in the [bootstrap guide](docs/bootstrap.md).

## Run locally

Restore, build, test, and start the standalone gateway:

```powershell
dotnet restore ./Cormier.Realtime.sln --locked-mode
dotnet build ./Cormier.Realtime.sln -c Release --no-restore
dotnet test ./Cormier.Realtime.sln -c Release --no-build
dotnet run --project ./src/Cormier.Realtime.Gateway
```

The development profile listens on `http://localhost:5097`. Redis is optional for process startup in the default development configuration; configure `Redis__Endpoint` when exercising distributed sessions, tickets, pub/sub, streams, or multi-instance behavior. The [developer guide](docs/developer-guide.md) documents the pinned Redis fixture and the broader local verification workflow.

The standalone gateway exposes these default routes:

- `/health/startup` — process initialization state.
- `/health/live` — process liveness.
- `/health/ready` — traffic readiness, including shutdown draining and configured dependencies.
- `/metrics` — Prometheus/OpenMetrics-compatible telemetry.
- `/realtime/ws` — authenticated WebSocket endpoint using `cormier.realtime.v1`.
- `/realtime/tickets` — same-origin issuance of short-lived, single-use connection tickets.

Diagnostics endpoints are disabled by default and have separate production, authorization, origin, and network controls. See the [diagnostics runbook](docs/runbooks/diagnostics.md) before enabling them.

## Preview a deployment

Copy `bootstrap/config.example.json` to an ignored or external location, replace every example target, keep credentials in existing Secret providers, and preview one explicit topology before making changes:

```powershell
New-Item -ItemType Directory -Force ./.bootstrap | Out-Null
Copy-Item ./bootstrap/config.example.json ./.bootstrap/config.json
pwsh ./scripts/Realtime-Bootstrap.ps1 -Action plan -Config ./.bootstrap/config.json -Profile non-ha
```

The equivalent Bash command is:

```bash
mkdir -p ./.bootstrap
cp ./bootstrap/config.example.json ./.bootstrap/config.json
bash ./scripts/realtime-bootstrap.sh plan --config ./.bootstrap/config.json --profile non-ha
```

Both wrappers call the same Node.js engine, validate the same versioned schema, and produce deterministic secret-redacted plans and Helm values. The supported actions cover prerequisites, planning, build bootstrap, backup, install, update, validation, rollback, recovery, and guarded teardown. Review the [bootstrap guide](docs/bootstrap.md) and [bootstrap contract](docs/bootstrap-contract.md) before applying a plan. The older PowerShell-only bootstrap and deployment scripts remain compatibility entry points during the version 1 transition.

Domains, origins, host names, addresses, CIDRs, ports, Redis endpoints, image repositories, Kubernetes identities, and Secret names are configuration inputs. Override development examples through `appsettings`, environment variables (double underscores separate .NET configuration keys), bootstrap configuration, Helm values, or deployment parameters. Never compile environment-specific network identities into the application or commit credentials, tokens, private keys, rendered Secrets, or production values.

## Build deployable artifacts

Publish the gateway for the runtime identifier matching the build host:

```powershell
$runtimeIdentifier = 'win-x64' # or linux-x64, osx-x64, osx-arm64
dotnet publish ./src/Cormier.Realtime.Gateway -c Release -r $runtimeIdentifier --self-contained
```

CI restores locked dependencies, builds and tests the solution, validates clean package consumers and both bootstrap topologies, checks Helm and Kubernetes output, runs cross-browser and reference-stack scenarios, publishes and smoke-tests a Linux x64 Native AOT executable and rootless read-only OCI image, scans artifacts, and emits an SBOM and immutable build evidence.

Application, container, NuGet package, npm package, Helm chart, scripts, and reference applications are coordinated at `1.0.3-beta`. The authoritative .NET and chart properties are controlled in `Directory.Build.props`; the TypeScript package version is in `sdk/typescript/package.json`. See the [package release policy](docs/package-release.md) for compatibility, reproducible package candidates, guarded promotion, and rollback.

## Clients and protocol

The TypeScript client produces deterministic ESM and direct-browser IIFE artifacts, readable and optimized web profiles, declarations, source maps, and integrity metadata. The .NET client targets .NET Standard 2.0. Both clients implement the versioned envelope, single-use ticket flow, bounded command handling, heartbeats, reconnect with fresh authentication, and duplicate-free subscription restoration.

Start with the [wire protocol](docs/protocol.md), [TypeScript SDK guide](docs/typescript-sdk.md), [.NET client guide](src/Cormier.Realtime.Client/README.md), and [optimized-assets guide](docs/optimized-assets.md). Applications embedding the gateway should use the [ASP.NET Core package guide](src/Cormier.Realtime.AspNetCore/README.md) and [minimal host example](examples/aspnet-core/README.md).

## Further documentation

- [Architecture](docs/architecture.md)
- [Developer guide](docs/developer-guide.md)
- [Cross-platform bootstrap](docs/bootstrap.md)
- [Operator runbooks](docs/runbooks/README.md)
- [Helm chart](helm/README.md)
- [Observability](observability/README.md)
- [Load testing](load/README.md)
- [Security policy](SECURITY.md)
