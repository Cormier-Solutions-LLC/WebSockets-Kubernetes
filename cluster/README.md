# Cluster deployment

The gateway supports exactly one Redis mode per release. `external` points to an operator-managed endpoint; set TLS appropriately and restrict `externalRedisCidrs`. `managed` installs `oci://registry-1.docker.io/bitnamicharts/redis` chart `23.1.1` (Redis `8.2.1`) with replication, Sentinel quorum, persistent AOF storage, disruption budgets, resource bounds, NetworkPolicy, and exporter metrics.

Secrets are never stored in values. Create the gateway Secret in advance with a key matching the ACL username (default `realtime`) and a distinct administrator credential in `redis-password`; automation checks the configured key names without reading or logging values. Bitnami's native ACL support mounts the Secret on every Redis and Sentinel node, persists the identity across restarts/failover, and restricts it to the configured key/channel prefix and command set. External Redis should likewise use separate session, realtime, and administrator credentials and prefixes.

TLS is deliberately disabled in the in-cluster managed example because traffic is constrained by NetworkPolicy. Enable Bitnami TLS with a separately managed certificate Secret wherever cluster policy requires encryption in transit.

The gateway discovers the writable primary through Sentinel service `mymaster` on port 26379. Before upgrades, run `Deploy-Realtime.ps1 -Action BackupRedis`. It requests `BGSAVE`, copies the RDB from the current primary, and records it below ignored `.backups`. Test restore in a non-production namespace and retain copies outside the cluster.

See the examples under `cluster/redis`. Never commit rendered Secrets or credential-bearing values.
