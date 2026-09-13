# Developer guide

## ASP.NET Core hosting package

`Cormier.Realtime.AspNetCore` exposes `AddRealtimeGateway`, `UseRealtimeGateway`, and `MapRealtimeGateway` for applications that need the realtime gateway inside an existing ASP.NET Core host. The package binds and validates the same `Gateway`, `Redis`, `Proxy`, and `Realtime` configuration sections used by the standalone gateway.

For standard ASP.NET Core session integration, configure `Realtime:SessionSource` as `AspNetCoreSession`, register session services, and place `UseSession` before the mapped endpoints execute. The configured session identifier is revalidated through `IRealtimeSessionStore` on initial connection and during the connection lifetime, so expiration, logout/revocation, tenant scope, and multi-instance reconnect retain the Redis contract.

The runnable example is under `examples/aspnet-core`. `scripts/Test-AspNetCorePackage.ps1` packs the package and its project dependencies into a temporary local feed, then restores and compiles a clean consumer outside the repository tree.

## .NET Standard client

`Cormier.Realtime.Client` targets .NET Standard 2.0 and depends on the multi-targeted `Cormier.Realtime.Contracts` package. It provides a bounded `ClientWebSocket` lifecycle plus replaceable authentication, transport, retry, clock, and logging abstractions without referencing ASP.NET Core hosting assemblies.

The compatibility baseline is .NET Standard 2.0. CI restores, executes, and smoke-tests clean package consumers on .NET 8 and .NET 10; other .NET Standard 2.0 implementations must also support the package dependency versions listed in the NuGet artifact. See `src/Cormier.Realtime.Client/README.md` for authentication, subscription, publish, reconnect, cancellation, and extension examples.

## Supported development platforms

The repository supports Windows, Linux, and macOS development with PowerShell 7, plus Bash 5 or later on Linux and macOS, .NET SDK 10.0.303 or a later compatible .NET 10 feature band, and Node.js 22 or newer. Native AOT publishing additionally requires the platform compiler toolchain. Docker is optional for normal builds and required for local OCI runtime verification and the documented Redis test fixture.

## Bootstrap

Copy `bootstrap/config.example.json` to a secure operator-controlled location, replace every example target, select `ha` or `non-ha`, then run from any directory:

```powershell
pwsh /path/to/repository/scripts/Realtime-Bootstrap.ps1 -Action plan -Config /path/to/realtime-dev.json -Profile non-ha
pwsh /path/to/repository/scripts/Realtime-Bootstrap.ps1 -Action bootstrap -Config /path/to/realtime-dev.json -Profile non-ha
```

The equivalent Bash commands use `scripts/realtime-bootstrap.sh plan|bootstrap --config ... --profile non-ha`. Useful controls:

- `-DryRun`/`--dry-run` reports the normalized plan without external operations.
- `-TimeoutSeconds`/`--timeout-seconds` bounds external operations.
- `-ConfirmTopologyChange`/`--confirm-topology-change` is required after previewing a topology conversion.
- `-Force`/`--force` is required for guarded nonproduction teardown.

Both wrappers call the same implementation, validate the same versioned configuration, produce deterministic redacted plans/values and JSON logs, and have identical actions and exit semantics. See [the bootstrap guide](bootstrap.md) for the complete install, update, validation, backup, rollback, recovery, topology, and teardown contract. The legacy PowerShell-only entry points remain available during migration.

## Local workflow

```powershell
dotnet restore ./Cormier.Realtime.sln --locked-mode
dotnet build ./Cormier.Realtime.sln -c Release --no-restore
dotnet test ./Cormier.Realtime.sln -c Release --no-build
dotnet run --project ./src/Cormier.Realtime.Gateway
```

The TypeScript and browser validation is independently locked with `package-lock.json`:

```powershell
dotnet build ./Cormier.Realtime.sln -c Release
Push-Location ./sdk/typescript
npm ci
npm run check
npx playwright install chromium firefox webkit
npm run test:browser
npm pack --dry-run
Pop-Location
```

The browser suite starts two gateway processes plus an ordinary round-robin WebSocket proxy. It requires Redis at `REDIS_TEST_ENDPOINT` (default `127.0.0.1:6379`) and uses configurable loopback test ports. Details and troubleshooting are in [typescript-sdk.md](typescript-sdk.md).

Configuration uses normal ASP.NET Core providers. Environment variables use double underscores, for example `Gateway__ShutdownDrainSeconds=30` and `Redis__Endpoint=redis:6379`. Never commit Redis credentials or put secrets in command arguments.

TLS is expected to terminate at a trusted ingress. The gateway processes one `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` hop before origin checks, but only from CIDRs in `Proxy:TrustedNetworks`. Override the private-network defaults to match the cluster's actual ingress network; never configure untrusted public ranges.

For browser WebSocket testing, configure an exact origin in `Realtime__AllowedOrigins__0`, create a namespaced Redis session record, and send its ID in the configured HttpOnly cookie. Cross-origin tools should obtain a one-time ticket from `/realtime/tickets`. The full envelope, route, close-code, reconnect, and delivery contracts are in [protocol.md](protocol.md).

Redis Streams are disabled by default. Enable `Redis__StreamsEnabled=true` and populate `Realtime__DurableEventClasses__0` only for reviewed event classes. `StreamMaxLength`, `StreamClaimIdleMilliseconds`, `StreamIdempotencyTtlSeconds`, and `StreamPoisonMaxLength` must be chosen from the event's retention and recovery requirements.

The Redis integration suite expects `REDIS_TEST_ENDPOINT`. A local Docker example is:

```powershell
docker run --rm --name cormier-realtime-test-redis -p 127.0.0.1:16379:6379 redis:7.4-alpine
$env:REDIS_TEST_ENDPOINT = 'localhost:16379'
dotnet test ./tests/Cormier.Realtime.IntegrationTests -c Release
```

## Native AOT publish

Choose a runtime identifier that matches the host:

```powershell
dotnet publish ./src/Cormier.Realtime.Gateway -c Release -r win-x64 --self-contained
```

CI publishes and tests `linux-x64`. Any compiler, analyzer, trimming, or AOT warning is blocking. New JSON DTOs must be added to the source-generation context before use.

## OCI publishing

The gateway project uses the .NET SDK container publisher, a chiseled `runtime-deps` base, port 8080, and non-root UID 1654. CI produces an OCI archive without requiring a Dockerfile. For a local daemon publish:

```powershell
dotnet publish ./src/Cormier.Realtime.Gateway -c Release -r linux-x64 --self-contained /t:PublishContainer
```

## Failure behavior

Bootstrap validation fails before restore/build work and returns a non-zero exit code. Configuration errors stop host startup with the exact invalid setting. Logs are structured, secrets are never expected in source or command arguments, and diagnostics must remain redacted.
