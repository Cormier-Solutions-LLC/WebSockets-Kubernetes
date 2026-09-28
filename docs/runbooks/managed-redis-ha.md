# Managed Redis HA installation and recovery

This runbook records the complete supported path for a three-member Redis/Sentinel deployment used by the Cormier.Realtime gateway. It applies to Kubernetes clusters with at least three schedulable, zone-labeled failure domains and a dynamic `ReadWriteOnce` storage class. Commands may run from any secured administrator workstation or controller that has the intended kubeconfig; Kubernetes acts on the selected context, not on the machine where `kubectl` runs.

## Inputs and safety boundary

Copy `bootstrap/config.example.json` to an ignored or external location. Set every environment-specific field, especially:

- Kubernetes context, namespace, storage class, and failure-domain count;
- gateway image repository, version tag, immutable digest, and pull Secret;
- public DNS host, allowed HTTP origins, TLS Secret, WebSocket path, HTTP fallback path, and Traefik/MetalLB identities;
- managed Redis chart source, version, chart archive SHA-256, immutable Redis/Sentinel/exporter image coordinates, Secret/key names, key/channel prefix, and storage size;
- monitoring selectors and OTLP destinations.

The committed example pins the verified Bitnami Redis chart `23.1.1` archive and the Redis `8.2.1` image family by multi-platform digest. The image base distribution is part of that tested artifact. Do not independently replace it with a Debian 13 or rolling `latest` image: doing so changes Redis binaries, entrypoint behavior, and possibly the persisted RDB/AOF format. Test a chart/image/data upgrade together and retain a verified backup before changing any digest.

The bootstrap downloads the chart, verifies its archive checksum, and applies the reviewed Sentinel Service patch locally. The patch adds `publishNotReadyAddresses: true` to the normal Redis/Sentinel Service. The chart already sets it on the headless Service. This lets the first ordered member discover Sentinel before readiness without exposing Redis outside the cluster.

## 1. Verify the target

```bash
kubectl config current-context
kubectl version
helm version
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get storageclass
```

PowerShell uses the same commands. Helm 3.21 or later, Node.js 22 or later, and a standard `tar` command are supported by the lifecycle scripts.

## 2. Create password files without line endings

Generate two different, high-entropy passwords. Do not use `echo` without `-n`, an editor that silently appends a newline, or a password value directly on a process command line.

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
  --context CONTEXT \
  --namespace NAMESPACE \
  --secret-name REDIS_SECRET \
  --admin-password-file /secure/redis-admin-password.txt \
  --realtime-password-file /secure/realtime-password.txt \
  --admin-key redis-password \
  --realtime-key realtime \
  --create-namespace
```

```powershell
./scripts/Set-RealtimeRedisSecret.ps1 `
  -Context CONTEXT `
  -Namespace NAMESPACE `
  -SecretName REDIS_SECRET `
  -AdminInputFile C:\secure\realtime\redis-admin-password.txt `
  -RealtimeInputFile C:\secure\realtime\realtime-password.txt `
  -AdminKey redis-password `
  -RealtimeKey realtime `
  -CreateNamespace
```

`redis.credentialKey` is both the restricted ACL username and Secret key. `redis.adminCredentialKey` is the distinct default/admin password key. The bootstrap verifies names and references without logging password values.

## 3. Plan and validate

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

Review `.bootstrap/lifecycle/<release>/plan.json`, `values.json`, and `redis-values.json`. The HA Redis render must contain:

- three Redis/Sentinel pods and Sentinel quorum two;
- `podManagementPolicy: OrderedReady`;
- startup probe failure threshold `60` for Redis and Sentinel;
- immutable image digests rather than an unpinned effective image;
- `publishNotReadyAddresses: true` on both the regular and headless Services;
- persistent storage using the configured storage class;
- the restricted ACL key/channel prefix and command groups.

## 4. Install and validate both transports

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

The gateway IngressRoute sends both the configured WebSocket path and HTTP fallback path to the same sticky backend. WebSockets require connection upgrade support; HTTP fallback requests require cookie affinity so all requests for one fallback connection reach the same gateway replica.

Verify Redis first:

```bash
kubectl get pods,pvc,pdb,service --context CONTEXT --namespace NAMESPACE -o wide
kubectl get service REDIS_RELEASE REDIS_RELEASE-headless --context CONTEXT --namespace NAMESPACE \
  -o jsonpath='{range .items[*]}{.metadata.name}{" publishNotReady="}{.spec.publishNotReadyAddresses}{"\n"}{end}'
kubectl get statefulset REDIS_RELEASE-node --context CONTEXT --namespace NAMESPACE \
  -o jsonpath='podManagementPolicy={.spec.podManagementPolicy}{"\n"}'
kubectl exec --context CONTEXT --namespace NAMESPACE REDIS_RELEASE-node-0 --container redis -- \
  bash -ec 'REDISCLI_AUTH="$(< /opt/bitnami/redis/secrets/redis-password)" redis-cli -h 127.0.0.1 ping'
```

The last command must return `PONG`. Then use `scripts/Test-RealtimeEdge.ps1` with the configured host/path and a fresh ticket to verify HTTPS and WSS routing. Exercise an HTTP fallback client against the configured fallback base path and confirm the Traefik affinity cookie remains stable across connect, stream/poll, message, and close requests.

## Failure signatures and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `secret ... not found` | Helm started before the referenced Secret existed or names differ | Apply the Secret first; make release, Secret and key names agree; run `recover` |
| Redis/Sentinel stays unready while resolving the first master | Regular Sentinel Service does not publish not-ready endpoints | Use the verified patched chart; confirm both Services publish not-ready addresses |
| Startup probe restarts during normal Sentinel election | Probe budget is shorter than ordered cluster bootstrap | Keep the reviewed 60-attempt startup threshold; do not weaken readiness/liveness semantics |
| Exit `137` | Container was killed, commonly by the memory limit or startup-probe restart path | Check pod events and `lastState`; size memory from evidence and correct the underlying startup failure |
| `Can't handle RDB format version ...` | A newer Redis image wrote data that an older image cannot read | Restore a compatible backup or return to the writer version; delete PVCs only after proving the deployment contains no required data |
| `NOAUTH` followed by `WRONGPASS` | Password file included trailing CR/LF; ACL hashed raw bytes while shell substitution stripped them | Reapply the Secret with the helper, rerun Helm so `users.acl` is regenerated, and restart the StatefulSet through `recover` |
| Helm release is `pending-install` | An interrupted or timed-out install retained an operation lock | Let the bounded command finish; if it is definitively abandoned, uninstall that incomplete release and rerun install. Preserve PVCs unless data recovery explicitly requires otherwise |

Do not treat longer CrashLoopBackOff delays as a fix. Identify the first failing boundary: Secret mount, image/version, persisted-data compatibility, Redis startup, Sentinel discovery, authentication, readiness, Service endpoints, then gateway/ingress.

The `recover` action reapplies the verified managed Redis chart, explicitly restarts the Redis StatefulSet so updated Secret content is loaded, waits for that ordered rollout, and only then restarts and verifies the gateway. Pre-change backups retain the exact installed Redis chart archive and its computed SHA-256; rollback verifies that saved archive before restoring values. Keep the complete backup directory together.
