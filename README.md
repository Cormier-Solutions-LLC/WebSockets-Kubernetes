# Cormier Realtime Gateway

An independently deployable .NET 10 Native AOT foundation for the Cormier realtime WebSocket platform. The gateway is versioned and released separately from the PBV7 application.

## Repository layout

- `src/Cormier.Realtime.Gateway` — Native AOT ASP.NET Core gateway host.
- `src/Cormier.Realtime.Contracts` — source-generated JSON protocol contracts.
- `src/Cormier.Realtime.Redis` — Redis configuration and integration boundary.
- `src/Cormier.Realtime.AspNetCore` — reusable ASP.NET Core hosting integration package.
- `src/Cormier.Realtime.Client` — runtime-neutral .NET Standard 2.0 WebSocket client package.
- `tests` — unit, integration, Kubernetes, and load-test projects.
- `helm` and `cluster` — deployment assets developed by PBV7-487/PBV7-488.
- `observability` — dashboard and alert assets developed by PBV7-489.
- `sdk/typescript` — typed client and deterministic ESM/IIFE browser artifacts.
- `protocol/fixtures` — language-neutral wire-compatibility fixtures.
- `examples/browser` — plain HTML/direct-script consumer example.
- `examples/aspnet-core` — minimal package consumer using standard ASP.NET Core sessions.
- `examples/dotnet-client` — runtime-neutral .NET client connection and authentication example.
- `scripts` — PowerShell 7 bootstrap and lifecycle automation.
- `docs` — architecture and developer guidance.
- `refs` — source Jira exports and governing scripting standard.

## Quick start

Prerequisites are PowerShell 7, the .NET 10 SDK, Git, Node.js 22 or newer for the browser SDK, and optionally Docker for OCI verification.

```powershell
pwsh ./scripts/Bootstrap-Realtime.ps1
dotnet run --project ./src/Cormier.Realtime.Gateway
```

Use an optional DNS-label suffix of at most 27 characters for a separately named distribution or deployment. Together with deployment environment names of at most 10 characters, this keeps gateway and managed-Redis Helm releases within Helm's 53-character limit. The bootstrap writes the resulting, non-secret naming contract to ignored `.bootstrap/naming.json` and MSBuild properties to `.bootstrap/naming.props`:

```powershell
pwsh ./scripts/Bootstrap-Realtime.ps1 -NameSuffix customer-a -ImageRegistry ghcr.io/cormier-solutions-llc
# application: realtime-customer-a; service: cormier-realtime-customer-a-gateway
```

`Deploy-Realtime.ps1` consumes the generated Kubernetes application, scopes the Redis prefix by deployment environment, and passes the full generated image repository to Helm unless those parameters are explicitly supplied. .NET container publishing imports the matching registry/repository properties; explicit deployment or MSBuild properties can still override them.

Domains, origins, host/server names, IPs, CIDRs, ports, Redis endpoints, image repositories, and Kubernetes identities are configuration inputs. Override the development examples through `appsettings`, environment variables (double underscores separate .NET configuration keys), Helm values, or deployment-script parameters; do not compile environment-specific network identities into the application.

For observability, set `observability.cluster` to the Prometheus cluster scope and replace the TEST-NET `observability.platformMetrics.metalLbAddress` default with the edge LoadBalancer VIP. Redis exporter namespace/instance and the remaining platform selectors are independently configurable under `observability.platformMetrics`.

The gateway listens on the ASP.NET Core configured address and exposes:

- `/health/startup` — process initialization state.
- `/health/live` — process liveness only.
- `/health/ready` — traffic readiness, including draining state.
- `/metrics` — Prometheus text-format foundation metrics.
- `/realtime/ws` — authenticated WebSocket endpoint using `cormier.realtime.v1`.
- `/realtime/tickets` — issues a short-lived, single-use connection ticket from a same-origin session.

See [wire protocol](docs/protocol.md), [developer guide](docs/developer-guide.md), and [architecture](docs/architecture.md) for the complete behavior and design boundaries.

Applications that host the gateway inside an existing ASP.NET Core process can use `Cormier.Realtime.AspNetCore`. See the [package guide](src/Cormier.Realtime.AspNetCore/README.md) and [minimal host](examples/aspnet-core/README.md).

## Build and verify

```powershell
dotnet restore ./Cormier.Realtime.sln --locked-mode
dotnet build ./Cormier.Realtime.sln -c Release --no-restore
dotnet test ./Cormier.Realtime.sln -c Release --no-build

# Choose the RID matching the build host: win-x64, linux-x64, osx-x64, or osx-arm64.
$runtimeIdentifier = 'win-x64'
dotnet publish ./src/Cormier.Realtime.Gateway -c Release -r $runtimeIdentifier --self-contained
```

Linux CI publishes a `linux-x64` Native AOT executable and an OCI archive from the .NET SDK. Versions begin at `0.1.0` and are controlled centrally by `Directory.Build.props`.

Package identities, compatibility, local-feed verification, guarded promotion, and rollback are documented in the [package release policy](docs/package-release.md).

## Browser SDK

The strict TypeScript client under `sdk/typescript` produces readable and minified ESM and direct-browser IIFE artifacts plus centralized readable and optimized reference-web profiles. It supports same-origin sessions, single-use tickets, bounded command handling, heartbeats, reconnect with fresh authentication, and duplicate-free subscription restoration. See [the TypeScript SDK guide](docs/typescript-sdk.md) for the API and compatibility contract, and [the optimized-assets guide](docs/optimized-assets.md) for profiles, manifests, CSP/SRI, source maps, accessibility, and rollback.
