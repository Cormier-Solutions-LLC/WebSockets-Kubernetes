# Scripts

All automation in this directory targets PowerShell 7 and follows `refs/scripts-standard-v4.2.md`. Run `Bootstrap-Realtime.ps1` to validate prerequisites, create the stable repository directories, restore packages, and build the solution.
Pass `-NameSuffix <dns-label>` (maximum 38 characters) to derive a consistent instance identity such as `realtime-customer-a`; the ignored `.bootstrap/naming.json` manifest contains the corresponding service, container, Redis-prefix, and Kubernetes application names. Deployment automation consumes the application and automatically adds the deployment environment to the Redis prefix unless explicitly overridden, and `.bootstrap/naming.props` supplies the repository name to .NET container publishing.
`Deploy-Realtime.ps1` is the Kubernetes lifecycle entry point. Run `Get-Help ./scripts/Deploy-Realtime.ps1 -Full` for its contract. It requires an explicit context and derives the namespace/release as `<environment>-<application>`.

Examples:

```powershell
./scripts/Deploy-Realtime.ps1 -Action Validate -Environment dev -ExpectedContext kind-dev
./scripts/Deploy-Realtime.ps1 -Action Plan -Environment dev -ExpectedContext kind-dev -ValuesFile ./cluster/redis/external-values.example.yaml
./scripts/Deploy-Realtime.ps1 -Action Deploy -Environment prod -ExpectedContext production -ValuesFile ./prod-values.yaml -ManagedRedis
```

`Remove` and `RestoreRedis` require `-Force`. `RedisUsername`, `RedisPasswordKey`, and `RedisAdminPasswordKey` select Secret keys without accepting their values; in managed mode the password key must match the ACL username as required by the pinned Redis chart. Automation uses an exclusive per-target lock, bounded timeouts, pre-change state capture, redacted logs, validated archive rotation, and forced gateway rollouts after credential rotation. It never creates Secrets.
