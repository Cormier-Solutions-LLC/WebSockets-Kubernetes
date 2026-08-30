# Cluster deployment

The gateway supports exactly one Redis mode per release. `external` points to an operator-managed endpoint; set TLS appropriately and restrict `externalRedisCidrs`. `managed` installs `oci://registry-1.docker.io/bitnamicharts/redis` chart `23.1.1` (Redis `8.2.1`) with replication, Sentinel quorum, persistent AOF storage, disruption budgets, resource bounds, NetworkPolicy, and exporter metrics.

Secrets are never stored in values. Create the gateway Secret in advance with a key matching the ACL username (default `realtime`) and a distinct administrator credential in `redis-password`; automation checks the configured key names without reading or logging values. Bitnami's native ACL support mounts the Secret on every Redis and Sentinel node, persists the identity across restarts/failover, and restricts it to the configured key/channel prefix and command set. External Redis should likewise use separate session, realtime, and administrator credentials and prefixes.

TLS is deliberately disabled in the in-cluster managed example because traffic is constrained by NetworkPolicy. Enable Bitnami TLS with a separately managed certificate Secret wherever cluster policy requires encryption in transit.

The gateway discovers the writable primary through Sentinel service `mymaster` on port 26379. Before upgrades, run `Deploy-Realtime.ps1 -Action BackupRedis`. It requests `BGSAVE`, copies the RDB from the current primary, and records it below ignored `.backups`. Test restore in a non-production namespace and retain copies outside the cluster.

See the examples under `cluster/redis`. Never commit rendered Secrets or credential-bearing values.

## Development edge exposure

`cluster/edge/development` is the environment-scoped edge configuration. It deliberately leaves the gateway Service as `ClusterIP`; only Traefik has a `LoadBalancer` Service. Apply `metallb.yaml` after confirming that `192.168.50.240-192.168.50.250` is reserved for this environment, then install Traefik chart `34.3.0` from `https://traefik.github.io/charts`:

```sh
helm repo add traefik https://traefik.github.io/charts
helm upgrade --install traefik traefik/traefik --version 34.3.0 --namespace traefik --create-namespace --values cluster/edge/development/traefik-values.yaml
```

Deploy the gateway with `gateway-values.yaml` to the `development-realtime` namespace and apply `certificate.yaml` after the `propago-local-ca` ClusterIssuer is available.

The Traefik Service is annotated for ExternalDNS to create `realtime.propago.local`. The Traefik route accepts only `realtime.propago.local/realtime/ws`, terminates TLS with the certificate Secret, and streams upgrades without response buffering. Gateway origin validation remains authoritative through `gateway.allowedOrigins`; Traefik access logs drop all request headers and request path/address fields, preventing credentials and query-string tickets from entering edge diagnostics. Traefik's Prometheus endpoint and the gateway's internal `/metrics` endpoint provide edge and gateway telemetry. The 60-second read/write and 120-second idle edge timeouts exceed the gateway's 15-second heartbeat while bounding connections for this dedicated entry point.

The LoadBalancer uses `externalTrafficPolicy: Local`: MetalLB advertises the VIP only from nodes with local ready Traefik endpoints and Traefik receives the original client source IP. Three Traefik replicas, hostname spread, and its disruption budget maintain two available replicas. For BGP environments, replace the `L2Advertisement` with a MetalLB `BGPAdvertisement` referencing the same pool—do not advertise one pool through both mechanisms.

Gateway readiness turns false before its 25-second drain interval, which withdraws it from Traefik endpoints. It sends restart notices, then closes remaining sockets; Kubernetes grants 35 seconds, exceeding the app shutdown timeout by five seconds. Roll back as a unit by restoring the prior gateway release, route/certificate Secret, Traefik values, and MetalLB advertisement/pool after withdrawing the replacement VIP.

Run `Test-RealtimeEdge.ps1` against a non-production environment after each edge change. It validates DNS, certificate readiness, MetalLB VIP assignment, source-IP policy, two non-terminating gateway endpoints, TLS routing, and an optional ticket-authenticated long WSS connection. The ticket is supplied only through `REALTIME_EDGE_TICKET` and is never logged. Before promotion, use a dedicated maintenance window to repeat this validation while restarting Traefik, rolling the gateway, draining a node, and failing over a MetalLB speaker/VIP; preserve the resulting redacted logs and edge metrics as release evidence.
