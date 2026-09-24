# Scripts

The production bootstrap and Kubernetes lifecycle is documented in [`docs/bootstrap.md`](../docs/bootstrap.md). `Realtime-Bootstrap.ps1` and `realtime-bootstrap.sh` are equivalent wrappers around one versioned configuration, normalized plan, and implementation. The full-circle packaged-consumer lifecycle is documented separately in [`examples/full-circle/README.md`](../examples/full-circle/README.md).

The shared bootstrap supports Bash 5+ or PowerShell 7+ and requires Node.js 22+ on PATH. Cluster actions additionally require the configured .NET/Git/Helm/kubectl prerequisites described in the bootstrap guide. Edge validation requires PowerShell 7.4+ for pinned authenticated WebSocket transport. The [Scripts Standard 4.2 snapshot](../refs/scripts-standard-v4.2.md) provides reference guidance; individual script contracts define implemented behavior. The older `Bootstrap-Realtime.ps1` and `Deploy-Realtime.ps1` remain compatibility entry points during the v1 migration; new lifecycle features belong in the shared engine and both wrappers.

For the shared lifecycle, pass `-Config` (or `CORMIER_BOOTSTRAP_CONFIG`) and select topology in the versioned JSON. `-Topology` / its `-Profile` alias asserts that choice; `-NameSuffix` overrides the configured suffix. Bash uses `--config`, `--profile`, and `--name-suffix`. Configure image identity in JSON, not through a nonexistent shared-wrapper `-ImageRegistry` parameter. The shared engine writes ignored `.bootstrap/naming.json` with the complete environment-qualified Redis prefix.

The legacy `Bootstrap-Realtime.ps1` accepts `-NameSuffix <dns-label>` (maximum 27 characters) and `-ImageRegistry`; it also writes `.bootstrap/naming.props` for .NET container publishing. `Deploy-Realtime.ps1` consumes matching application/image identities and the Redis prefix from `naming.json` unchanged; without a matching manifest it derives `<environment>:<application>`. Its environment parameter is limited to 10 characters and release names must fit Helm's 53-character limit. Run `Get-Help ./scripts/Deploy-Realtime.ps1 -Full` for this compatibility contract. Prefer the shared lifecycle for new deployments.

`Build-RealtimePackages.ps1` is the package-candidate entry point. It requires configured NuGet, repository/project/release-notes URLs and, for a publishable candidate, a Redis test endpoint and clean source tree. It performs locked restore, Release build/tests, two pack runs, content and dependency-bound inspection, and clean-consumer checks, then records a SHA-256 manifest under `artifacts/packages/<commit>` by default. `-SkipIntegrationTests` produces a nonpublishable local candidate. `Publish-RealtimePackages.ps1` verifies and promotes those exact bytes without rebuilding; npm publication is explicitly opt-in. Promotion credentials are supplied through named environment variables, and approval policy is enforced by the release workflow/operator, not created by the script itself. See [the package release policy](../docs/package-release.md).

## Entry points and outputs

| Entry point | Purpose / prerequisites | Output or reference |
| --- | --- | --- |
| `Realtime-Bootstrap.ps1`, `realtime-bootstrap.sh` | Shared Node.js lifecycle: prerequisites, plan, bootstrap, backup, install, update, validate, rollback, recover, teardown | `.bootstrap/lifecycle`, `.backups/bootstrap`, configured logs; [bootstrap guide](../docs/bootstrap.md) |
| `Bootstrap-Realtime.ps1`, `Deploy-Realtime.ps1` | Legacy developer bootstrap and Kubernetes lifecycle | `.bootstrap`, `.logs`, `.backups/<target>`; inspect PowerShell help |
| `FullCircle.ps1`, `full-circle.sh` | Shared Node.js packaged-consumer example lifecycle with explicit `ha` / `non-ha` profile | [FullCircle guide](../examples/full-circle/README.md) |
| `Get-PackageReleaseIntent.ps1`, `Build-RealtimePackages.ps1`, `Publish-RealtimePackages.ps1` | Coordinated version-change detection, candidate validation, and immutable promotion; PowerShell 7 and .NET 10, plus Node/npm for build or npm publication | Release intent, package artifacts, `.logs`, promotion evidence |
| `configure-nuget-trusted-publishing.sh` | Configure the GitHub environment for NuGet.org OIDC Trusted Publishing; GitHub CLI with repository admin access | `package-production` source variable and user secret, policy instructions, optional package-workflow dispatch |
| `Test-AspNetCorePackage.ps1`, `Test-BrowserPackage.ps1`, `Test-DotNetClientPackage.ps1` | Isolated feed and clean consumer validation; configured upstream NuGet source | Temporary feeds/consumers cleaned after validation |
| `Test-RealtimeEdge.ps1`, `Invoke-RealtimeEdgeFailureTest.ps1` | Read-only edge checks or explicitly approved disruptive exercises; PowerShell 7.4+, kubectl, curl | Edge evidence; [cluster guide](../cluster/README.md) |
| `Invoke-RealtimeLoad.ps1` | .NET load runner; explicit endpoint, Origin and session | `artifacts/load-results.json` by default; [load guide](../load/README.md) |
| `setup-ci-powershell.sh`, `start-ci-redis.sh`, `verify-observability.sh` | CI helpers for tooling, disposable Redis and observability checks | See invocations and environment inputs in [CI](../.github/workflows/ci.yml) |

The `.mjs` files and `lib/bootstrap-contract.mjs` implement shared engines/contracts; they are not independent alternative deployment policies. Run examples from the repository root. Keep plans, logs, backups and evidence out of commits: even redacted files can contain environment identities. No documentation example below authorizes a live cluster change by itself.

```powershell
$env:CORMIER_BOOTSTRAP_CONFIG = 'C:\secure\config\realtime-dev.json'
./scripts/Realtime-Bootstrap.ps1 -Action plan -Topology non-ha
./scripts/Realtime-Bootstrap.ps1 -Action prerequisites -Topology non-ha
```

Shared lifecycle exit codes are 0 success, 1 prerequisite/execution failure, 2 invalid input and 3 safety stop. Correct the reported configuration path or missing prerequisite before rerunning `plan`; use the documented backup for rollback. `teardown` requires `-Force`, refuses production configuration, and preserves namespaces/storage. Other scripts have their own exit contracts; do not apply these numbers globally.

Legacy deployment examples (replace context, environment and values with the intended target):

```powershell
./scripts/Deploy-Realtime.ps1 -Action Validate -Environment dev -ExpectedContext kind-dev
./scripts/Deploy-Realtime.ps1 -Action Plan -Environment dev -ExpectedContext kind-dev -ValuesFile ./cluster/redis/external-values.example.yaml
./scripts/Deploy-Realtime.ps1 -Action Deploy -Environment prod -ExpectedContext production -ValuesFile ./prod-values.yaml -ManagedRedis
```

Legacy `Remove` and `RestoreRedis` require `-Force`. `RedisUsername` is the ACL username; `RedisPasswordKey` and `RedisAdminPasswordKey` select existing Secret keys without accepting password values. In managed mode the password key must match the ACL username. Deployment automation uses a per-target lock, timeouts, pre-change state capture, redacted logs, archive rotation, and gateway rollouts after credential rotation. It never creates credential Secrets.

`Test-RealtimeEdge.ps1` performs read-only external edge validation after deployment. It verifies the assigned MetalLB VIP, configurable L2/BGP advertisement scope, active announcer placement, `externalTrafficPolicy: Local`, certificate readiness (including single-label wildcard coverage), ready non-terminating gateway endpoints, DNS, TLS routing, and optionally an authenticated long-lived WSS connection. Curl and authenticated WSS traffic are pinned to the selected MetalLB VIP by default; `-ExternalAddress` overrides that transport address for a configurable NAT or test endpoint while retaining `-HostName` for TLS SNI and certificate-name validation. Custom trust can come from `-CertificateAuthorityPath` or the public cert-manager status selected by `-CertificateAuthorityCertificateName` and `-CertificateAuthorityCertificateNamespace`; no Secret object is read. Every certificate in the bundle is loaded as a trust anchor and peer-supplied intermediates are retained. `-GatewayMetricsPort` can override the metrics target, otherwise the named `http` container port is derived from the Deployment. Pass `-ExpectedClientIp` to verify a request from the current run in Traefik's JSON `ClientHost` field. Supply the initial single-use WSS ticket through the configurable ticket environment variable; `-TicketRefreshCommand` supplies a fresh ticket after an expected service-restart close without logging it. The ticket is necessarily sent in the gateway's query-string protocol, so the Traefik values drop request path, address, port, and all header access-log fields.

```powershell
$env:REALTIME_EDGE_TICKET = '<ephemeral-ticket>'
./scripts/Test-RealtimeEdge.ps1 -ExpectedContext kind-development
```

Failure scenarios serialize through one context-wide lock. Cluster administrators configure its single canonical namespace by labeling exactly one Active namespace `cormier.io/edge-failure-lock=canonical`; the operator needs ConfigMap permissions there.

`Invoke-RealtimeEdgeFailureTest.ps1` runs one bounded failure scenario at a time against an explicitly named non-production context and acquires an atomic context-wide ConfigMap lock before mutation. Before mutation, every affected namespace must carry matching `cormier.io/environment=<environment>`, `cormier.io/environment-class=nonproduction`, and `cormier.io/failure-testing=approved` labels. Node drain additionally requires those labels on the named node and every namespace containing a pod that drain can evict, and requires that node to host the selected gateway or Traefik workload. It captures an unauthenticated baseline, then establishes one authenticated WSS connection with a fresh single-use ticket before injecting the failure and keeps that connection active until the mutation explicitly signals completion and a final ping is acknowledged. Gateway pod deletion identifies and deletes the replica serving that socket through its per-pod active-connection metric; gateway pod deletion and rollout require `-TicketRefreshCommand` so an expected close reconnects through another ready gateway with a new ticket. Baseline and recovery deliberately skip inherited tickets so they cannot consume or reuse one. For node drain, continuity and full configured replica redistribution must both succeed while the node remains cordoned; this intentionally requires N+1 schedulable capacity. The node is then restored to its original schedulable state. The script restores reversible state in `finally` and writes redacted evidence below the configurable evidence directory. Certificate renewal uses a parallel Certificate/Secret, validates the replacement through a new TLS connection while routed, and never removes the serving Secret. Backend outage temporarily removes and then restores the selected HPA so autoscaling cannot race the injection. L2 speaker restart derives the active announcer from `ServiceL2Status`; BGP requires the explicit configurable `-MetalLbSpeakerNode` and verifies that node is an active announcer with a ready local Traefik endpoint. Use `-WhatIf` to inspect a run without consuming the ticket; mutating continuity scenarios require a fresh ticket in the configurable ticket environment variable and confirmation unless the operator deliberately supplies `-Confirm:$false`.

```powershell
kubectl label namespace edge-operations cormier.io/edge-failure-lock=canonical --overwrite
kubectl label namespace development-realtime traefik metallb-system cormier.io/environment=development cormier.io/environment-class=nonproduction cormier.io/failure-testing=approved --overwrite
# For NodeDrain only, apply the same three safety labels to the explicitly selected nonproduction node.
$ticketRefreshCommand = 'C:\ops\New-RealtimeTicket.ps1' # Operator-provided command that prints one fresh ticket.
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario GatewayPodDelete -Environment development -ExpectedContext kind-development -TicketRefreshCommand $ticketRefreshCommand
./scripts/Invoke-RealtimeEdgeFailureTest.ps1 -Scenario NodeDrain -Environment development -ExpectedContext kind-development -NodeName worker-1 -AllowNodeDrain -TicketRefreshCommand $ticketRefreshCommand
```
