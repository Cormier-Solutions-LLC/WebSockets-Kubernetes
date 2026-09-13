# Bootstrap workflow inventory and contract

Contract version: 1

| Existing capability | Shared v1 action | Bash | PowerShell | Inputs and safety |
|---|---|---|---|---|
| Prerequisite/bootstrap validation | `prerequisites`, `bootstrap`, `install` | `realtime-bootstrap.sh` | `Realtime-Bootstrap.ps1` | Versioned config, locked restore, Release build, dry run, bounded commands |
| Deployment plan/render | `plan`, `validate` | same | same | Explicit context, namespace, profile; deterministic redacted output |
| Install/update | `install`, `update` | same | same | Target lock, backup, atomic Helm wait, health verification |
| Backup/rollback/recovery | `backup`, `rollback`, `recover` | same | same | Matching backup target, bounded capture/restore/reapply |
| Guarded removal | `teardown` | same | same | Force required; production refused; PV/namespace preserved |
| Managed/external Redis | all mutation actions | same | same | Existing Secret references only; managed/external selected in config |
| HA/non-HA conversion | `plan`, `update`, `rollback` | same | same | Explicit preview and confirmation; backup before change |

The inventory covers `Bootstrap-Realtime.ps1`, `Deploy-Realtime.ps1`, their documented examples/runbooks, Helm render/deploy operations, and the full-circle example lifecycle. The full-circle wrappers remain a distinct package-consumer test surface and already share one engine. Build/package, edge failure-test, and load-test scripts are developer/verification tools rather than bootstrap entry points; they remain cross-platform where their supported runtime permits or are invoked by the shared CI contract.

Both shells expose the same actions, configuration, defaults, normalized plan, JSON logging vocabulary (`info`, `pass`, `error`), summaries, and process exit behavior. Shell code is limited to argument translation and process invocation. Environment-variable naming is `CORMIER_BOOTSTRAP_CONFIG` for the config path; deployment configuration itself lives in the versioned file so shells cannot diverge through different environment defaults.

Legacy PowerShell-only bootstrap/deploy scripts are deprecated compatibility shims for v1. The migration mapping and support policy are in `bootstrap.md`. Review fails if a new bootstrap capability lacks both entry points or bypasses the shared engine.
