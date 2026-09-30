# Managed Redis HA installation and recovery

This runbook records the complete supported path for a three-member Redis/Sentinel deployment used by the Cormier.Realtime gateway. It applies to Kubernetes clusters with at least three schedulable, zone-labeled failure domains and a dynamic `ReadWriteOnce` storage class. Commands may run from any secured administrator workstation or controller that has the intended kubeconfig; Kubernetes acts on the selected context, not on the machine where `kubectl` runs.

## Inputs and safety boundary

Copy `bootstrap/config.ha.example.json` to an ignored or external location. It is a schema-valid production-shaped template, not deployable defaults. Set every environment-specific field, especially:

- Kubernetes context, namespace, storage class, and failure-domain count;
- gateway image repository, version tag, immutable digest, and pull Secret;
- public DNS host, allowed HTTP origins, TLS Secret, WebSocket path, HTTP fallback path, and Traefik/MetalLB identities;
- managed Redis chart source, version, chart archive SHA-256, immutable Redis/Sentinel/exporter image coordinates, any existing private-registry pull Secrets, credential Secret/key names, key/channel prefix, and storage size;
- monitoring selectors and OTLP destinations.

The committed example pins the verified Bitnami Redis chart `23.1.1` archive and the Redis `8.2.1` image family by multi-platform digest. The image base distribution is part of that tested artifact. Do not independently replace it with a Debian 13 or rolling `latest` image: doing so changes Redis binaries, entrypoint behavior, and possibly the persisted RDB/AOF format. Test a chart/image/data upgrade together and retain a verified backup before changing any digest.

The bootstrap downloads the chart, verifies its archive checksum, and applies the reviewed Sentinel Service patch locally. The patch adds `publishNotReadyAddresses: true` to the normal Redis/Sentinel Service. The chart already sets it on the headless Service. This lets the first ordered member discover Sentinel before readiness without exposing Redis outside the cluster. Keep the ignored `.bootstrap/env/<environment>/lifecycle/<release>/charts` cache with the administration workspace; later backups intentionally refuse to invent provenance by downloading new bytes for an old chart tag.

## 1. Verify the target

```bash
kubectl config current-context
kubectl version
helm version
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get storageclass
```

PowerShell uses the same commands. Helm 3.21 or later, Node.js 22 or later, and a standard `tar` command are supported by the lifecycle scripts. Run these from the controller only when that is where the intended kubeconfig and tools live; a secured workstation with the same context reaches the same API and is equally valid.

## 2. Create password files without line endings

Generate two different, high-entropy passwords. Do not use `echo` without `-n`, an editor that silently appends a newline, a value containing NUL bytes, or a password directly on a process command line.

```bash
install -d -m 700 /secure
umask 077
printf '%s' "$(openssl rand -hex 32)" > /secure/redis-admin-password.txt
printf '%s' "$(openssl rand -hex 32)" > /secure/realtime-password.txt
```

PowerShell example:

```powershell
$directory = 'C:\secure\realtime'
New-Item -ItemType Directory -Force $directory | Out-Null
$adminBytes = [byte[]]::new(32)
$realtimeBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($adminBytes)
[Security.Cryptography.RandomNumberGenerator]::Fill($realtimeBytes)
$admin = [Convert]::ToHexString($adminBytes).ToLowerInvariant()
$realtime = [Convert]::ToHexString($realtimeBytes).ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $directory 'redis-admin-password.txt'), $admin)
[IO.File]::WriteAllText((Join-Path $directory 'realtime-password.txt'), $realtime)
```

Use the repository helper to remove trailing CR/LF bytes, reject embedded newlines or identical passwords, and submit the Secret through standard input.

```bash
bash ./scripts/realtime-redis-secret.sh \
  --config /secure/realtime-prod.json \
  --admin-password-file /secure/redis-admin-password.txt \
  --realtime-password-file /secure/realtime-password.txt \
  --create-namespace
```

```powershell
./scripts/Set-RealtimeRedisSecret.ps1 `
  -Config C:\secure\realtime-prod.json `
  -AdminInputFile C:\secure\realtime\redis-admin-password.txt `
  -RealtimeInputFile C:\secure\realtime\realtime-password.txt `
  -CreateNamespace
```

Configuration mode derives context, namespace, Secret name, and both keys from the same validated file used by Helm, preventing a release/Secret naming mismatch. Explicit target flags remain available for recovery workflows. `redis.credentialKey` is both the restricted ACL username and Secret key. `redis.adminCredentialKey` is the distinct default/admin password key, and managed-mode planning rejects duplicate key names. The helper rejects embedded line endings, NUL bytes, all-whitespace values, and identical credentials without logging password values.

## 3. Create and wait for the TLS certificate

When cert-manager owns TLS, apply the `Certificate` from the same config before gateway validation. The issuer must already exist. The helper waits for `Ready=True`, which guarantees the referenced TLS Secret exists before Helm checks it.

```bash
bash ./scripts/realtime-certificate.sh \
  --config /secure/realtime-prod.json \
  --issuer-name letsencrypt-prod \
  --issuer-kind ClusterIssuer \
  --timeout-seconds 600
```

```powershell
./scripts/Set-RealtimeCertificate.ps1 `
  -Config C:\secure\realtime-prod.json `
  -IssuerName letsencrypt-prod `
  -IssuerKind ClusterIssuer `
  -TimeoutSeconds 600
```

If another system owns the TLS Secret, do not run this helper; leave `ingress.certificateName` empty and set `ingress.tlsSecretName` to that existing Secret. Confirm cert-manager state with `kubectl get certificates,certificaterequests --all-namespaces` and `kubectl describe certificate CERTIFICATE --namespace NAMESPACE`.

## 4. Plan and validate

```bash
bash ./scripts/realtime-bootstrap.sh plan --config /secure/realtime-prod.json --profile ha
bash ./scripts/realtime-bootstrap.sh prerequisites --config /secure/realtime-prod.json --profile ha
bash ./scripts/realtime-bootstrap.sh validate --config /secure/realtime-prod.json --profile ha --timeout-seconds 1200
```

```powershell
./scripts/Realtime-Bootstrap.ps1 -Action plan -Config C:\secure\realtime-prod.json -Topology ha
./scripts/Realtime-Bootstrap.ps1 -Action prerequisites -Config C:\secure\realtime-prod.json -Topology ha
./scripts/Realtime-Bootstrap.ps1 -Action validate -Config C:\secure\realtime-prod.json -Topology ha -TimeoutSeconds 1200
```

Review `.bootstrap/env/<environment>/lifecycle/<release>/plan.json`, `values.json`, and `redis-values.json`. The HA Redis render must contain:

- three Redis/Sentinel pods and Sentinel quorum two;
- `podManagementPolicy: OrderedReady`;
- startup probe failure threshold `60` for Redis and Sentinel;
- pod DNS options `timeout=2`, `attempts=3`, and `single-request-reopen`;
- an authenticated Sentinel startup command that sets `TILT-TRIGGER` to `10000` milliseconds;
- immutable image digests rather than an unpinned effective image;
- `publishNotReadyAddresses: true` on both the regular and headless Services;
- persistent storage using the configured storage class;
- the restricted ACL key/channel prefix and command groups.

## 5. Install and validate both transports

```bash
bash ./scripts/realtime-bootstrap.sh install \
  --config /secure/realtime-prod.json \
  --profile ha \
  --timeout-seconds 1200
```

```powershell
./scripts/Realtime-Bootstrap.ps1 `
  -Action install `
  -Config C:\secure\realtime-prod.json `
  -Topology ha `
  -TimeoutSeconds 1200
```

The gateway IngressRoute sends both the configured WebSocket path and HTTP fallback path to the same sticky backend. The paths must differ case-insensitively, and the WebSocket path cannot reuse the gateway's fixed ticket, health, or metrics endpoints. WebSockets require connection upgrade support; HTTP fallback requests require cookie affinity so all requests for one fallback connection reach the same gateway replica. The managed-HA Redis endpoint includes `sentinelUser=default`: Sentinel uses the administrator credential while Redis data traffic uses the restricted `realtime` ACL identity.

Verify Redis first:

```bash
kubectl get pods,pvc,pdb,service --context CONTEXT --namespace NAMESPACE -o wide
kubectl get service REDIS_RELEASE REDIS_RELEASE-headless --context CONTEXT --namespace NAMESPACE \
  -o jsonpath='{range .items[*]}{.metadata.name}{" publishNotReady="}{.spec.publishNotReadyAddresses}{"\n"}{end}'
kubectl get statefulset REDIS_RELEASE-node --context CONTEXT --namespace NAMESPACE \
  -o jsonpath='podManagementPolicy={.spec.podManagementPolicy}{"\n"}'
kubectl exec --context CONTEXT --namespace NAMESPACE REDIS_RELEASE-node-0 --container redis -- \
  bash -ec 'REDISCLI_AUTH="$(< /opt/bitnami/redis/secrets/redis-password)" redis-cli -h 127.0.0.1 ping'
kubectl exec --context CONTEXT --namespace NAMESPACE REDIS_RELEASE-node-0 --container redis -- \
  bash -ec 'REDISCLI_AUTH="$(< /opt/bitnami/redis/secrets/redis-password)" redis-cli --raw -h 127.0.0.1 -p 26379 SENTINEL DEBUG | grep -A1 TILT-TRIGGER'
```

The Redis command must return `PONG`; the Sentinel command must return `TILT-TRIGGER` followed by `10000` on every member. Verify `SENTINEL CKQUORUM mymaster` reports three usable Sentinels, then force one controlled nonproduction failover and compare the complete hostname returned by `SENTINEL get-master-addr-by-name mymaster`. Sentinel can acknowledge `FAILOVER` before promotion completes, so poll until the hostname changes instead of assuming a fixed sleep is sufficient.

Use `scripts/Test-RealtimeEdge.ps1` with the configured host/path and a fresh single-use ticket to verify HTTPS and authenticated WSS routing. Exercise an HTTP fallback client against the configured fallback base path and confirm the Traefik affinity cookie remains stable across connect, stream/poll, message, and close requests. Without a ticket, `POST /realtime/tickets` and a syntactically valid WebSocket upgrade should return `401`; a plain GET to the WebSocket route commonly returns `400`. Those responses prove routing reached Kestrel but do not prove authenticated transport. `X-Cormier-Origin-Validated: true` on the unauthenticated upgrade confirms the Origin passed validation.

## Failure signatures and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `secret ... not found` | Helm started before the referenced Secret existed or names differ | Apply the Secret first; make release, Secret and key names agree; run `recover` |
| Redis/Sentinel stays unready while resolving the first master | Regular Sentinel Service does not publish not-ready endpoints | Use the verified patched chart; confirm both Services publish not-ready addresses |
| Startup probe restarts during normal Sentinel election | Probe budget is shorter than ordered cluster bootstrap | Keep the reviewed 60-attempt startup threshold; do not weaken readiness/liveness semantics |
| Exit `137` | Container was killed, commonly by the memory limit or startup-probe restart path | Check pod events and `lastState`; size memory from evidence and correct the underlying startup failure |
| `Can't handle RDB format version ...` | A newer Redis image wrote data that an older image cannot read | Restore a compatible backup or return to the writer version; delete PVCs only after proving the deployment contains no required data |
| `NOAUTH` followed by `WRONGPASS` | Password file included trailing CR/LF; ACL hashed raw bytes while shell substitution stripped them | Reapply the Secret with the helper, rerun Helm so `users.acl` is regenerated, and restart the StatefulSet through `recover` |
| Gateway startup reports `WRONGPASS` only against Sentinel | The Sentinel connection authenticated as the restricted data user | Confirm rendered `Redis__Endpoint` contains `sentinelUser=default` and that `Redis__SentinelPassword` references the administrator key |
| Sentinel enters TILT or failover remains unchanged | DNS stalls or a clock/scheduler pause exceeded the Sentinel timing guard | Confirm all three DNS options and `TILT-TRIGGER 10000` are rendered and active; then inspect Sentinel logs and quorum before retrying |
| Helm reports `another operation ... is in progress` | A Helm process is still active or the release is genuinely stuck in a pending state | Check the original process first and wait for it. If no process owns the operation, inspect `helm history`; uninstall only an incomplete first install or roll back to an actual deployed revision number. Never type a placeholder such as `DEPLOYED_REVISION` literally |
| Helm release is `pending-install` | An interrupted first install retained an operation lock | Confirm no Helm process is active, preserve PVCs, uninstall only the incomplete release, and rerun the bounded install |
| Certificate is Ready but HTTPS fails | DNS, Traefik entry point, IngressRoute, or TLS Secret wiring differs from the config | Compare `dig`, Certificate `spec.secretName`, IngressRoute TLS Secret, Service endpoints, and Traefik logs |

Do not treat longer CrashLoopBackOff delays as a fix. `137` means the process received `SIGKILL`; use `kubectl describe pod`, container `lastState`, resource usage, and events to distinguish an OOM kill from kubelet termination after repeated probe failures. Identify the first failing boundary: Secret mount, image/version, persisted-data compatibility, Redis startup, Sentinel discovery, authentication, readiness, Service endpoints, then gateway/ingress. Empty gateway logs after a successful rollout are normal when no requests or warnings occurred.

The `recover` action reapplies the verified managed Redis chart, explicitly restarts the topology-appropriate Redis StatefulSet (`-node` for HA or `-master` for non-HA) so updated Secret content is loaded, waits for that rollout, and only then restarts and verifies the gateway. Verified chart archives and provenance metadata remain in the ignored lifecycle directory so normal backup, update, validation, and recovery do not require another registry download. Pre-change backups retain the exact installed Redis chart archive and its computed SHA-256; rollback verifies that saved archive before restoring values. A fresh workstation without that cache must restore trusted provenance from backup; it must not download current bytes and declare them equivalent to the installed release. Keep the complete backup directory together.
