# Cluster deployment

The gateway supports exactly one Redis mode per release. `external` points to an operator-managed endpoint; set TLS appropriately and restrict `externalRedisCidrs`. `managed` installs `oci://registry-1.docker.io/bitnamicharts/redis` chart `23.1.1` (Redis `8.2.1`) with replication, Sentinel quorum, persistent AOF storage, disruption budgets, resource bounds, NetworkPolicy, and exporter metrics.

Secrets are never stored in values. Create the gateway Secret in advance with `realtime-username` and `realtime-password`. The managed release also requires a distinct administrator credential in `redis-password`; automation checks these keys without reading or logging values. A bounded Helm hook uses the administrator credential to idempotently provision the realtime ACL identity, restricted to its configured key/channel prefix and required command categories. External Redis should likewise use separate session, realtime, and administrator credentials and prefixes.

TLS is deliberately disabled in the in-cluster managed example because traffic is constrained by NetworkPolicy. Enable Bitnami TLS with a separately managed certificate Secret wherever cluster policy requires encryption in transit.

Before upgrades, run `Deploy-Realtime.ps1 -Action BackupRedis`. It requests `BGSAVE`, copies the RDB from the current primary, and records it below `.backups`. Test restore in a non-production namespace and retain copies outside the cluster.

See the examples under `cluster/redis`. Never commit rendered Secrets or credential-bearing values.

## Development edge exposure

`cluster/edge/development` is the environment-scoped edge configuration. It deliberately leaves the gateway Service as `ClusterIP`; only Traefik has a `LoadBalancer` Service. Apply `metallb.yaml` after confirming that `192.168.50.240-192.168.50.250` is reserved for this environment, then install the pinned local Traefik chart with `traefik-values.yaml`. Deploy the gateway with `gateway-values.yaml` to the `development-realtime` namespace and apply `certificate.yaml` after the `propago-local-ca` ClusterIssuer is available.

The Traefik Service is annotated for ExternalDNS to create `realtime.propago.local`. The Traefik route accepts only `realtime.propago.local/realtime/ws`, terminates TLS with the certificate Secret, and streams upgrades without response buffering. Gateway origin validation remains authoritative through `gateway.allowedOrigins`; Traefik access logs drop all request headers, including credentials and tickets. Traefik's Prometheus endpoint and the gateway's internal `/metrics` endpoint provide edge and gateway telemetry. Infinite edge responding timeouts are intentional for long-lived WebSockets; application heartbeat and idle handling enforce the connection lifetime.

The LoadBalancer uses `externalTrafficPolicy: Local`: MetalLB advertises the VIP only from nodes with local ready Traefik endpoints and Traefik receives the original client source IP. Three Traefik replicas and its disruption budget maintain two available replicas. For BGP environments, replace the `L2Advertisement` with a MetalLB `BGPAdvertisement` referencing the same pool—do not advertise one pool through both mechanisms.

Gateway readiness turns false before its 25-second drain interval, which withdraws it from Traefik endpoints. It sends restart notices, then closes remaining sockets; Kubernetes grants 35 seconds, exceeding the app shutdown timeout by five seconds. Roll back as a unit by restoring the prior gateway release, route/certificate Secret, Traefik values, and MetalLB advertisement/pool after withdrawing the replacement VIP. Validate DNS, certificate chain, allowed host/path/origin, a long-lived WSS connection, rollout drain, Traefik restart, node drain, and VIP failover before promotion.
