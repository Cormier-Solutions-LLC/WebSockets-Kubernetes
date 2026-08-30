# Cluster deployment

The gateway supports exactly one Redis mode per release. `external` points to an operator-managed endpoint; set TLS appropriately and restrict `externalRedisCidrs`. `managed` installs `oci://registry-1.docker.io/bitnamicharts/redis` chart `23.1.1` (Redis `8.2.1`) with replication, Sentinel quorum, persistent AOF storage, disruption budgets, resource bounds, NetworkPolicy, and exporter metrics.

Secrets are never stored in values. Create the gateway Secret in advance with `realtime-username` and `realtime-password`. The managed release also requires a distinct administrator credential in `redis-password`; automation checks these keys without reading or logging values. A bounded Helm hook uses the administrator credential to idempotently provision the realtime ACL identity, restricted to its configured key/channel prefix and required command categories. External Redis should likewise use separate session, realtime, and administrator credentials and prefixes.

TLS is deliberately disabled in the in-cluster managed example because traffic is constrained by NetworkPolicy. Enable Bitnami TLS with a separately managed certificate Secret wherever cluster policy requires encryption in transit.

Before upgrades, run `Deploy-Realtime.ps1 -Action BackupRedis`. It requests `BGSAVE`, copies the RDB from the current primary, and records it below `.backups`. Test restore in a non-production namespace and retain copies outside the cluster.

See the examples under `cluster/redis`. Never commit rendered Secrets or credential-bearing values.
