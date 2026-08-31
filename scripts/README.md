# Scripts

All automation in this directory targets PowerShell 7 and follows `refs/scripts-standard-v4.2.md`. Run `Bootstrap-Realtime.ps1` to validate prerequisites, create the stable repository directories, restore packages, and build the solution.
Pass `-NameSuffix <dns-label>` (maximum 27 characters) to derive a consistent instance identity such as `realtime-customer-a`; environment names are limited to 10 characters so derived gateway and managed-Redis releases remain within Helm's 53-character limit. `-ImageRegistry` configures the registry host and optional namespace. The ignored `.bootstrap/naming.json` manifest contains the corresponding service, image, Redis-prefix, and Kubernetes application names. Deployment automation consumes the application and image repository and adds the deployment environment to the Redis prefix unless explicitly overridden; `.bootstrap/naming.props` supplies the matching registry/repository to .NET container publishing.
`Deploy-Realtime.ps1` is the Kubernetes lifecycle entry point. Run `Get-Help ./scripts/Deploy-Realtime.ps1 -Full` for its contract. It requires an explicit context and derives the namespace/release as `<environment>-<application>`.

Examples:

```powershell
./scripts/Deploy-Realtime.ps1 -Action Validate -Environment dev -ExpectedContext kind-dev
./scripts/Deploy-Realtime.ps1 -Action Plan -Environment dev -ExpectedContext kind-dev -ValuesFile ./cluster/redis/external-values.example.yaml
./scripts/Deploy-Realtime.ps1 -Action Deploy -Environment prod -ExpectedContext production -ValuesFile ./prod-values.yaml -ManagedRedis
```

`Remove` and `RestoreRedis` require `-Force`. `RedisUsername`, `RedisPasswordKey`, and `RedisAdminPasswordKey` select Secret keys without accepting their values; in managed mode the password key must match the ACL username as required by the pinned Redis chart. Automation uses an exclusive per-target lock, bounded timeouts, pre-change state capture, redacted logs, validated archive rotation, and forced gateway rollouts after credential rotation. It never creates Secrets.

`Test-RealtimeEdge.ps1` performs read-only external edge validation after deployment. It verifies the assigned MetalLB VIP, configurable L2/BGP advertisement scope, speaker placement, `externalTrafficPolicy: Local`, certificate readiness, ready non-terminating gateway endpoints, DNS, TLS routing, and optionally an authenticated long-lived WSS connection. `-ExternalAddress` pins both curl and authenticated WSS traffic to a configurable address while retaining `-HostName` for TLS SNI and certificate-name validation. Pass `-ExpectedClientIp` to verify a request from the current run in Traefik's JSON `ClientHost` field. Supply the single-use WSS ticket via `REALTIME_EDGE_TICKET`; the script never logs it. The ticket is necessarily sent in the gateway's query-string protocol, so the Traefik values drop request path, address, port, and all header access-log fields.

```powershell
$env:REALTIME_EDGE_TICKET = '<ephemeral-ticket>'
./scripts/Test-RealtimeEdge.ps1 -ExpectedContext kind-development
```

`Invoke-RealtimeEdgeFailureTest.ps1` runs one bounded failure scenario at a time against an explicitly named non-production context. Before mutation, the gateway namespace must carry matching `cormier.io/environment=<environment>` and `cormier.io/failure-testing=approved` labels. It captures a baseline and active-failure continuity evidence, restores reversible state in `finally`, waits for every configured gateway and Traefik replica, and writes redacted evidence below the configurable evidence directory. Certificate renewal uses a parallel Certificate/Secret and never removes the serving Secret. L2 speaker restart derives the active announcer from `ServiceL2Status`; BGP requires the explicit configurable `-MetalLbSpeakerNode`. Use `-WhatIf` to inspect a run; mutating runs require confirmation unless the operator deliberately supplies `-Confirm:$false`.

```powershell
kubectl label namespace development-realtime cormier.io/environment=development cormier.io/failure-testing=approved --overwrite
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario GatewayPodDelete -Environment development -ExpectedContext kind-development
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario NodeDrain -Environment development -ExpectedContext kind-development -NodeName worker-1 -AllowNodeDrain
```
