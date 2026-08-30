# Propago Realtime Gateway

An independently deployable .NET 10 Native AOT foundation for the Propago realtime WebSocket platform. The gateway is versioned and released separately from the PBV7 application.

## Repository layout

- `src/Propago.Realtime.Gateway` — Native AOT ASP.NET Core gateway host.
- `src/Propago.Realtime.Contracts` — source-generated JSON protocol contracts.
- `src/Propago.Realtime.Redis` — Redis configuration and integration boundary.
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
dotnet run --project ./src/Propago.Realtime.Gateway
```

The gateway listens on the ASP.NET Core configured address and exposes:

- `/health/startup` — process initialization state.
- `/health/live` — process liveness only.
- `/health/ready` — traffic readiness, including draining state.
- `/metrics` — Prometheus text-format foundation metrics.

See [developer guide](docs/developer-guide.md) and [architecture](docs/architecture.md) for the complete workflow and design boundaries.

## Build and verify

```powershell
dotnet restore ./Propago.Realtime.sln --locked-mode
dotnet build ./Propago.Realtime.sln -c Release --no-restore
dotnet test ./Propago.Realtime.sln -c Release --no-build

# Choose the RID matching the build host: win-x64, linux-x64, osx-x64, or osx-arm64.
$runtimeIdentifier = 'win-x64'
dotnet publish ./src/Propago.Realtime.Gateway -c Release -r $runtimeIdentifier --self-contained
```

Linux CI publishes a `linux-x64` Native AOT executable and an OCI archive from the .NET SDK. Versions begin at `0.1.0` and are controlled centrally by `Directory.Build.props`.
