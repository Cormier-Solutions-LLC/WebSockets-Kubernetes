# Cormier Realtime Gateway

An independently deployable .NET 10 Native AOT foundation for the Cormier realtime WebSocket platform. The gateway is versioned and released separately from the PBV7 application.

## Repository layout

- `src/Cormier.Realtime.Gateway` — Native AOT ASP.NET Core gateway host.
- `src/Cormier.Realtime.Contracts` — source-generated JSON protocol contracts.
- `src/Cormier.Realtime.Redis` — Redis configuration and integration boundary.
- `tests` — unit, integration, Kubernetes, and load-test projects.
- `helm` and `cluster` — deployment assets developed by PBV7-487/PBV7-488.
- `observability` — dashboard and alert assets developed by PBV7-489.
- `scripts` — PowerShell 7 bootstrap and lifecycle automation.
- `docs` — architecture and developer guidance.
- `refs` — source Jira exports and governing scripting standard.

## Quick start

Prerequisites are PowerShell 7, the .NET 10 SDK, Git, and optionally Docker for OCI verification.

```powershell
pwsh ./scripts/Bootstrap-Realtime.ps1
dotnet run --project ./src/Cormier.Realtime.Gateway
```

Use an optional DNS-label suffix of at most 38 characters for a separately named distribution or deployment. The bootstrap writes the resulting, non-secret naming contract to ignored `.bootstrap/naming.json` and MSBuild properties to `.bootstrap/naming.props`:

```powershell
pwsh ./scripts/Bootstrap-Realtime.ps1 -NameSuffix customer-a
# application: realtime-customer-a; service: cormier-realtime-customer-a-gateway
```

`Deploy-Realtime.ps1` consumes the generated Kubernetes application and scopes the generated Redis prefix by deployment environment unless those parameters are explicitly supplied. .NET container publishing imports the generated container repository; an explicit MSBuild property can still override it.

Domains, origins, host/server names, IPs, CIDRs, ports, Redis endpoints, image repositories, and Kubernetes identities are configuration inputs. Override the development examples through `appsettings`, environment variables (double underscores separate .NET configuration keys), Helm values, or deployment-script parameters; do not compile environment-specific network identities into the application.

The gateway listens on the ASP.NET Core configured address and exposes:

- `/health/startup` — process initialization state.
- `/health/live` — process liveness only.
- `/health/ready` — traffic readiness, including draining state.
- `/metrics` — Prometheus text-format foundation metrics.
- `/realtime/ws` — authenticated WebSocket endpoint using `cormier.realtime.v1`.
- `/realtime/tickets` — issues a short-lived, single-use connection ticket from a same-origin session.

See [wire protocol](docs/protocol.md), [developer guide](docs/developer-guide.md), and [architecture](docs/architecture.md) for the complete behavior and design boundaries.

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
