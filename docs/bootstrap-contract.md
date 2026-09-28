# Bootstrap workflow inventory and contract

Contract version: 2

| Existing capability | Shared v1 action | Bash | PowerShell | Inputs and safety |
|---|---|---|---|---|
| Prerequisite/bootstrap validation | `prerequisites`, `bootstrap`, `install` | `realtime-bootstrap.sh` | `Realtime-Bootstrap.ps1` | Versioned config, locked restore, Release build, dry run, bounded commands |
| Deployment plan/render | `plan`, `validate` | same | same | Explicit context, namespace, profile; deterministic redacted output |
| Install/update | `install`, `update` | same | same | Target lock, backup, atomic Helm wait, health verification |
| Backup/rollback/recovery | `backup`, `rollback`, `recover` | same | same | Matching backup target, bounded capture/restore/reapply |
| Guarded removal | `teardown` | same | same | Force required; production refused; PV/namespace preserved |
| Managed/external Redis | all mutation actions | same | same | Existing Secret references only; managed/external selected in config |
| Managed Redis Secret provisioning | separate helper | `realtime-redis-secret.sh` | `Set-RealtimeRedisSecret.ps1` | Explicit target and password files; strips trailing CR/LF; Secret submitted through stdin |
| Managed Redis chart preparation | automatic plus separate helper | `prepare-managed-redis-chart.sh` | `Prepare-ManagedRedisChart.ps1` | OCI source/version/archive SHA-256; fail-closed Sentinel Service patch |
| HA/non-HA conversion | `plan`, `update`, `rollback` | same | same | Explicit preview and confirmation; backup before change |

The inventory covers `Bootstrap-Realtime.ps1`, `Deploy-Realtime.ps1`, their documented examples/runbooks, Helm render/deploy operations, and the full-circle example lifecycle. The full-circle wrappers remain a distinct package-consumer test surface and already share one engine. Build/package, edge failure-test, and load-test scripts are developer/verification tools rather than bootstrap entry points; they remain cross-platform where their supported runtime permits or are invoked by the shared CI contract.

Both shells expose the same actions, configuration, defaults, normalized plan, JSON logging vocabulary (`info`, `pass`, `error`), summaries, and process exit behavior. Shell code is limited to argument translation and process invocation. Environment-variable naming is `CORMIER_BOOTSTRAP_CONFIG` for the config path; deployment configuration itself lives in the versioned file so shells cannot diverge through different environment defaults. The JSON contract is the parameter surface for domains, origins, paths, versions, digests, Kubernetes identities, storage, resources, and observability. Password bytes remain outside that contract and enter only through the dedicated Secret helper.

Legacy PowerShell-only bootstrap/deploy scripts are deprecated compatibility shims for v1. The migration mapping and support policy are in `bootstrap.md`. Review fails if a new bootstrap capability lacks both entry points or bypasses the shared engine.
