# Cross-platform bootstrap and topology guide

Cormier.Realtime has one versioned bootstrap contract and two supported entry points: `scripts/realtime-bootstrap.sh` for Bash 5 or later and `scripts/Realtime-Bootstrap.ps1` for PowerShell 7 or later. Both call the same Node.js 22+ engine, consume the same JSON configuration, render byte-identical plans and Helm values, use the same bounded operations, and return `0` for success, `1` for a prerequisite/execution failure, `2` for invalid input, or `3` for a safety stop.

## Quick start

Copy `bootstrap/config.example.json` outside source control, replace every example target with the intended environment, and select exactly one `topology` value: `non-ha` or `ha`. Never put credentials in the file. It contains only an existing Kubernetes Secret name and configurable key names.

```bash
export CORMIER_BOOTSTRAP_CONFIG=/secure/config/realtime-dev.json
bash ./scripts/realtime-bootstrap.sh plan --profile non-ha
bash ./scripts/realtime-bootstrap.sh prerequisites --profile non-ha
bash ./scripts/realtime-bootstrap.sh install --profile non-ha
```

```powershell
$env:CORMIER_BOOTSTRAP_CONFIG = 'C:\secure\config\realtime-dev.json'
./scripts/Realtime-Bootstrap.ps1 -Action plan -Profile non-ha
./scripts/Realtime-Bootstrap.ps1 -Action prerequisites -Profile non-ha
./scripts/Realtime-Bootstrap.ps1 -Action install -Profile non-ha
```

`--config`/`-Config` takes precedence over `CORMIER_BOOTSTRAP_CONFIG`. The actions are `prerequisites`, `plan`, `bootstrap`, `backup`, `install`, `update`, `validate`, `rollback`, `recover`, and `teardown`. `bootstrap` performs locked .NET restore and a Release build; `backup` captures the current target without changing it. Bash flags use kebab case; PowerShell parameters use normal PowerShell casing. `--dry-run`/`-DryRun`, the timeout, topology confirmation, backup path, and force switch have identical meaning.

## Topology decision

`non-ha` uses one gateway, standalone managed Redis when selected, no autoscaler, no disruption budget, and no spread constraint. It is intended for development or explicitly cost-constrained environments. A pod, node, Redis, ingress, storage, maintenance, or rollout interruption causes downtime; persistence is not failover and Redis Pub/Sub events cannot be replayed.

`ha` requires at least three configured and schedulable failure domains. It uses three gateway replicas, a two-available disruption budget, zone/host spreading, a rolling update with zero unavailable replicas, autoscaling from three replicas, and either managed Redis replication plus Sentinel or an operator-approved external HA endpoint. Cluster capacity, storage, DNS/TLS, ingress, MetalLB, and observability remain environment inputs and must be validated for the target.

The profile is explicit in configuration and is passed into the application as `Gateway__Topology`; replica count never selects it implicitly.

## Plans, updates, and recovery

Every invocation validates the complete configuration before contacting a cluster and writes a secret-redacted, stable-key-order plan and rendered values beneath ignored `.bootstrap/lifecycle`. Configure the ingress origins, Traefik pod labels, optional immutable image digest, external Redis TLS mode, and any OTLP egress CIDRs or workload selectors explicitly. JSON-line logs use the configured ignored log directory; validated matching logs older than seven days move to its `Archive` directory. Review `plan.json`, `values.json`, the target context/namespace, availability guarantees, change classification, and SHA-256 before mutation.

Install, update, recover, and rollback use an exclusive target, bounded Helm/Kubernetes waits, atomic Helm upgrades, pre-change release-value backups beneath ignored `.backups/bootstrap`, and post-rollout health verification. Backups fail closed and remove the partial snapshot if Helm returns an inline password, token, secret, credential, private key, authorization value, or cookie. Repeating install/update is supported. Existing Kubernetes Secrets are referenced and verified but never created or read.

For cluster-changing actions, the installed gateway release is the authoritative source of the prior topology; ignored local state is only an offline planning aid. An installed profile that differs from the requested profile classifies the operation as `topology-conversion`, including on a fresh checkout. Run `update --dry-run` against the intended cluster, review capacity and downtime implications, then rerun with `--confirm-topology-change` or `-ConfirmTopologyChange`. Storage is never deleted or silently resized. Use `rollback --backup <reported-directory>` (or `-Backup`) to restore captured release values and remove releases that did not exist when that snapshot was taken. `recover` reapplies desired state and verifies rollout health.

`teardown` requires `--force`/`-Force`, refuses production configurations, and removes only the configured gateway and managed-Redis releases. Namespace and persistent-volume deletion are deliberately outside this command.

## Validation and failure exercises

Run `validate` before and after changes. CI validates schema failures, secret rejection, deterministic output, cross-shell plan/error parity, both profiles, Helm lint/render, syntax, static analysis, and the repository’s locked restore/test/AOT/security gates.

For an HA release, execute the approved nonproduction failure scenarios in `docs/runbooks/README.md`: gateway pod deletion, node drain with N+1 capacity, Redis failover/recovery, ingress/Traefik interruption, rollout, and planned maintenance. Preserve redacted evidence and confirm readiness, drain behavior, reconnect through another replica, Redis recovery, and restored replica distribution. These disruptive exercises require the runbook’s nonproduction labels and are never run automatically against an arbitrary cluster.

## Support, migration, and deprecation

The former `Bootstrap-Realtime.ps1` and `Deploy-Realtime.ps1` remain compatibility entry points during the v1 transition. New automation should use this cross-shell contract. Their bootstrap, validate/plan, deploy, rollback, remove, backup/recovery capabilities map respectively to `prerequisites`/`install`, `validate`/`plan`, `install`/`update`, `rollback`, `teardown`, and the automatic backup plus `recover` actions. No new feature is added to only one legacy script.

Schema version 1 rejects unknown fields and invalid combinations. A future incompatible field change increments `schemaVersion`, ships migration notes, and retains a bounded deprecation window. Configuration, generated plans, backups, and logs may contain environment identity and must follow the operator’s retention policy; credentials must remain in the configured Secret provider.

Troubleshooting starts with the JSON error path emitted before mutation. A context mismatch, insufficient permissions/capacity, absent storage class/Secret, failed Helm lint, timeout, or unhealthy rollout terminates with a non-zero result while preserving the backup. Correct the target or prerequisite, run `plan`, then use `recover` or `rollback` as appropriate.
