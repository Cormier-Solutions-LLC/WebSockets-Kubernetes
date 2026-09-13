# Cluster deployment

The supported deployment path is the versioned bootstrap contract in `bootstrap/config.schema.json`, invoked through `scripts/realtime-bootstrap.sh` or `scripts/Realtime-Bootstrap.ps1`. It validates the complete target, renders secret-redacted gateway and managed-Redis values, pins every cluster command to the configured context and namespace, captures pre-change Helm state, and performs bounded atomic upgrades. Start with the [bootstrap guide](../docs/bootstrap.md); use the files in this directory as reviewed component examples, not as a substitute for a generated plan.

## Topology and Redis

Every release selects exactly one topology (`non-ha` or `ha`) and one Redis mode (`external` or `managed`):

- `non-ha` runs one gateway and, when managed Redis is selected, one standalone Redis instance. It has no disruption budget, autoscaling, Sentinel, or replica failover; rollout and infrastructure interruptions can cause downtime.
- `ha` requires at least three schedulable failure domains. It starts with three gateway replicas, a two-available disruption budget, topology spreading, autoscaling, and a zero-unavailable rolling update. Managed Redis uses one primary, three replicas, Sentinel with quorum two, persistent AOF storage, disruption budgets, resource bounds, NetworkPolicy, and exporter metrics.
- `external` connects to an operator-managed endpoint. Configure TLS, explicit egress CIDRs, credentials, availability confirmation for HA, and the instance prefix for that target.
- `managed` installs `oci://registry-1.docker.io/bitnamicharts/redis` chart `23.1.1` (Redis `8.2.1`). The selected topology determines whether the generated values use standalone Redis or replication with Sentinel.

The topology is passed to the application explicitly as `Gateway__Topology`; replica count does not infer it. Direct conversion between managed and external Redis is rejected because data migration is an operator responsibility. Converting between HA and non-HA requires an explicit confirmation after reviewing the generated plan, capacity, and downtime implications.

Secrets are never stored in configuration or rendered values. Create the configured Kubernetes Secret before installation. For managed Redis, `redis.credentialKey` is also the ACL username (the example uses `realtime`) and `redis.adminCredentialKey` identifies the distinct administrator password (the example uses `redis-password`). The generated ACL restricts the gateway identity to its configured key/channel prefix and command set. Automation verifies Secret existence and key names but never reads or logs their values.

Managed Redis TLS is disabled by the current bootstrap schema and traffic is constrained by NetworkPolicy. Use external Redis with TLS when the target policy requires encrypted Redis transport. Validate the provider's certificate, availability, persistence, backup, recovery, and credential-rotation behavior independently.

The `backup` action captures the installed gateway and managed-Redis Helm release inventory and values; it is not a Redis data backup. Preserve database backups through the selected Redis service's tested backup mechanism. The older `Deploy-Realtime.ps1` compatibility path retains `BackupRedis`/`RestoreRedis` for its managed deployment, but new automation should use the shared bootstrap engine and an independently verified data-protection procedure.

The files under `cluster/redis` are manual reference values:

- `managed-values.yaml` demonstrates the HA Bitnami Redis configuration and uses placeholder Secret identity `cormier-redis-auth`.
- `managed-gateway-values.example.yaml` demonstrates gateway-side managed Redis settings with separate placeholder identities that must be reconciled with the Redis values.
- `external-values.example.yaml` demonstrates TLS and egress settings for an external endpoint.

Replace every example identity and make the Redis chart and gateway Secret names, key names, username, and instance prefix agree before use. Never commit rendered Secrets, credential-bearing values, environment inventory, or production endpoints.

## Development edge exposure

`cluster/edge/development` is an environment-scoped example. It deliberately leaves the gateway Service as `ClusterIP`; only Traefik has a `LoadBalancer` Service. Every identity in these files—including namespaces, release names, DNS names, certificate resources, pool names, and addresses—is configuration and must be replaced for the target environment. The committed `192.0.2.240-192.0.2.250` pool is an RFC 5737 documentation range and is intentionally not deployable as-is. Apply `metallb.yaml` only after replacing it with a reserved range routable in the target environment, then install Traefik chart `34.3.0` from `https://traefik.github.io/charts`:

```sh
helm repo add traefik https://traefik.github.io/charts
helm upgrade --install traefik traefik/traefik --version 34.3.0 --namespace traefik --create-namespace --values cluster/edge/development/traefik-values.yaml
```

Deploy the gateway with `gateway-values.yaml` to the `development-realtime` namespace and apply `certificate.yaml` after the `cormier-local-ca` ClusterIssuer is available.

The Traefik Service is annotated for ExternalDNS to create `realtime.cormier.local`. The Traefik route accepts only `realtime.cormier.local/realtime/ws`, terminates TLS with the certificate Secret, and streams upgrades without response buffering. Gateway origin validation remains authoritative through `gateway.allowedOrigins`; Traefik access logs drop all request headers and request path/address fields, preventing credentials and query-string tickets from entering edge diagnostics. Traefik's Prometheus endpoint and the gateway's internal `/metrics` endpoint provide edge and gateway telemetry. The 60-second read/write and 120-second idle edge timeouts exceed the gateway's 15-second heartbeat while bounding connections for this dedicated entry point.

The LoadBalancer uses `externalTrafficPolicy: Local`: MetalLB advertises the VIP only from nodes with local ready Traefik endpoints and Traefik receives the original client source IP. Three Traefik replicas, hostname spread, and its disruption budget maintain two available replicas. For BGP environments, replace the `L2Advertisement` with a MetalLB `BGPAdvertisement` referencing the same pool—do not advertise one pool through both mechanisms.

Gateway readiness turns false before its 25-second drain interval, which withdraws it from Traefik endpoints. It sends restart notices, then closes remaining sockets; Kubernetes grants 35 seconds, exceeding the app shutdown timeout by five seconds. Roll back as a unit by restoring the prior gateway release, route/certificate Secret, Traefik values, and MetalLB advertisement/pool after withdrawing the replacement VIP.

Run `scripts/Test-RealtimeEdge.ps1` against a non-production environment after each edge change. It validates DNS, certificate readiness, MetalLB VIP assignment, source-IP policy, two non-terminating gateway endpoints, TLS routing, and an optional ticket-authenticated long WSS connection. The ticket is supplied only through `REALTIME_EDGE_TICKET` and is never logged. Use `scripts/Invoke-RealtimeEdgeFailureTest.ps1` in a dedicated maintenance window for the approved reversible failure scenarios, including Traefik restart, gateway rollout, node drain, and MetalLB speaker restart; preserve the resulting redacted logs and edge metrics as release evidence.
