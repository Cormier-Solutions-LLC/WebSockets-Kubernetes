# Scripts

All automation in this directory targets PowerShell 7; edge validation requires PowerShell 7.4 or later for pinned authenticated WebSocket transport. The scripts follow `refs/scripts-standard-v4.2.md`. Run `Bootstrap-Realtime.ps1` to validate prerequisites, create the stable repository directories, restore packages, and build the solution.
Pass `-NameSuffix <dns-label>` (maximum 27 characters) to derive a consistent instance identity such as `realtime-customer-a`; environment names are limited to 10 characters so derived gateway and managed-Redis releases remain within Helm's 53-character limit. `-ImageRegistry` configures the registry host and optional namespace. The ignored `.bootstrap/naming.json` manifest contains the corresponding service, image, Redis-prefix, and Kubernetes application names. Deployment automation consumes the application and image repository and adds the deployment environment to the Redis prefix unless explicitly overridden; `.bootstrap/naming.props` supplies the matching registry/repository to .NET container publishing.
`Deploy-Realtime.ps1` is the Kubernetes lifecycle entry point. Run `Get-Help ./scripts/Deploy-Realtime.ps1 -Full` for its contract. It requires an explicit context and derives the namespace/release as `<environment>-<application>`.

Examples:

```powershell
./scripts/Deploy-Realtime.ps1 -Action Validate -Environment dev -ExpectedContext kind-dev
./scripts/Deploy-Realtime.ps1 -Action Plan -Environment dev -ExpectedContext kind-dev -ValuesFile ./cluster/redis/external-values.example.yaml
./scripts/Deploy-Realtime.ps1 -Action Deploy -Environment prod -ExpectedContext production -ValuesFile ./prod-values.yaml -ManagedRedis
```

`Remove` and `RestoreRedis` require `-Force`. `RedisUsername`, `RedisPasswordKey`, and `RedisAdminPasswordKey` select Secret keys without accepting their values; in managed mode the password key must match the ACL username as required by the pinned Redis chart. Automation uses an exclusive per-target lock, bounded timeouts, pre-change state capture, redacted logs, validated archive rotation, and forced gateway rollouts after credential rotation. It never creates Secrets.

`Test-RealtimeEdge.ps1` performs read-only external edge validation after deployment. It verifies the assigned MetalLB VIP, configurable L2/BGP advertisement scope, speaker placement, `externalTrafficPolicy: Local`, certificate readiness (including single-label wildcard coverage), ready non-terminating gateway endpoints, DNS, TLS routing, and optionally an authenticated long-lived WSS connection. `-ExternalAddress` pins both curl and authenticated WSS traffic to a configurable address while retaining `-HostName` for TLS SNI and certificate-name validation. The independently configurable CA Secret namespace/name/key projects only the public certificate bundle without reading other Secret data; every certificate in the bundle is loaded as a trust anchor and peer-supplied intermediates are retained. `-GatewayMetricsPort` can override the metrics target, otherwise the named `http` container port is derived from the Deployment. Pass `-ExpectedClientIp` to verify a request from the current run in Traefik's JSON `ClientHost` field. Supply the initial single-use WSS ticket through the configurable ticket environment variable; `-TicketRefreshCommand` supplies a fresh ticket after an expected service-restart close without logging it. The ticket is necessarily sent in the gateway's query-string protocol, so the Traefik values drop request path, address, port, and all header access-log fields.

```powershell
$env:REALTIME_EDGE_TICKET = '<ephemeral-ticket>'
./scripts/Test-RealtimeEdge.ps1 -ExpectedContext kind-development
```

`Invoke-RealtimeEdgeFailureTest.ps1` runs one bounded failure scenario at a time against an explicitly named non-production context and acquires an atomic per-edge ConfigMap lock before mutation. Before mutation, every affected namespace must carry matching `cormier.io/environment=<environment>` and `cormier.io/failure-testing=approved` labels. Node drain additionally requires those labels on the named node and requires that node to host the selected gateway or Traefik workload. It captures an unauthenticated baseline, then establishes one authenticated WSS connection with a fresh single-use ticket before injecting the failure and keeps that connection active until the mutation explicitly signals completion and a final ping is acknowledged. Gateway rollout requires `-TicketRefreshCommand` so an expected 1012 service-restart close reconnects through another ready gateway with a new ticket. Baseline and recovery deliberately skip inherited tickets so they cannot consume or reuse one. The script restores reversible state in `finally`, waits for every configured gateway and Traefik replica, and writes redacted evidence below the configurable evidence directory. Certificate renewal uses a parallel Certificate/Secret, validates the replacement through a new TLS connection while routed, and never removes the serving Secret. Backend outage temporarily removes and then restores the selected HPA so autoscaling cannot race the injection. L2 speaker restart derives the active announcer from `ServiceL2Status`; BGP requires the explicit configurable `-MetalLbSpeakerNode`. Use `-WhatIf` to inspect a run without consuming the ticket; mutating continuity scenarios require a fresh ticket in the configurable ticket environment variable and confirmation unless the operator deliberately supplies `-Confirm:$false`.

```powershell
kubectl label namespace development-realtime traefik metallb-system cormier.io/environment=development cormier.io/failure-testing=approved --overwrite
# For NodeDrain only, apply the same two labels to the explicitly selected nonproduction node.
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario GatewayPodDelete -Environment development -ExpectedContext kind-development
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario NodeDrain -Environment development -ExpectedContext kind-development -NodeName worker-1 -AllowNodeDrain
```
