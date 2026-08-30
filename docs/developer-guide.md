# Developer guide

## Supported development platforms

The repository supports Windows, Linux, and macOS development with PowerShell 7 and .NET SDK 10.0.303 or a later compatible .NET 10 feature band. Native AOT publishing additionally requires the platform compiler toolchain. Docker is optional for normal builds and required for local OCI runtime verification.

## Bootstrap

Run from any directory:

```powershell
pwsh /path/to/repository/scripts/Bootstrap-Realtime.ps1
```

Useful controls:

- `-WhatIf` or `-DryRun` reports intended bootstrap operations.
- `-SkipRestore` skips NuGet restore.
- `-SkipBuild` skips the release build.
- `-RequireContainer` makes Docker CLI and daemon validation mandatory.

The script validates prerequisites before build work, produces a redacted log under `.logs`, reports `CREATED`, `UNCHANGED`, or `SKIPPED` directory state, and archives completed logs older than seven days only after validating the ZIP.

## Local workflow

```powershell
dotnet restore ./Cormier.Realtime.sln --locked-mode
dotnet build ./Cormier.Realtime.sln -c Release --no-restore
dotnet test ./Cormier.Realtime.sln -c Release --no-build
dotnet run --project ./src/Cormier.Realtime.Gateway
```

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
