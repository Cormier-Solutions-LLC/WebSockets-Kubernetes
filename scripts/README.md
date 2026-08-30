# Scripts

All automation in this directory targets PowerShell 7 and follows `refs/scripts-standard-v4.2.md`. Run `Bootstrap-Realtime.ps1` to validate prerequisites, create the stable repository directories, restore packages, and build the solution.
`Deploy-Realtime.ps1` is the Kubernetes lifecycle entry point. Run `Get-Help ./scripts/Deploy-Realtime.ps1 -Full` for its contract. It requires an explicit context and derives the namespace/release as `<environment>-<application>`.

Examples:

```powershell
./scripts/Deploy-Realtime.ps1 -Action Validate -Environment dev -ExpectedContext kind-dev
./scripts/Deploy-Realtime.ps1 -Action Plan -Environment dev -ExpectedContext kind-dev -ValuesFile ./cluster/redis/external-values.example.yaml
./scripts/Deploy-Realtime.ps1 -Action Deploy -Environment prod -ExpectedContext production -ValuesFile ./prod-values.yaml -ManagedRedis
```

`Remove` and `RestoreRedis` require `-Force`. Automation uses an exclusive per-target lock, bounded timeouts, pre-change state capture, redacted logs, and validated archive rotation. It does not accept credentials as parameters and never creates Secrets.

`Test-RealtimeEdge.ps1` performs read-only external edge validation after deployment. It verifies the assigned MetalLB VIP, `externalTrafficPolicy: Local`, certificate readiness, ready non-terminating gateway endpoints, DNS, TLS routing, and optionally an authenticated long-lived WSS connection. Supply the single-use WSS ticket via `REALTIME_EDGE_TICKET`; the script never logs it.

```powershell
$env:REALTIME_EDGE_TICKET = '<ephemeral-ticket>'
./scripts/Test-RealtimeEdge.ps1 -ExpectedContext kind-development
```
