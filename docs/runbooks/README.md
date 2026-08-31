# Realtime gateway operations runbooks

All commands require explicit context, namespace, release, and endpoint parameters. Never copy a production address, credential, or Secret value into this repository or an incident ticket.

## Deployment, promotion, and rollback

1. Confirm CI passed build, tests, Native AOT smoke, rootless/read-only container smoke, dependency review, Trivy scans, and SBOM generation.
2. Configure the repository variables `CONTAINER_REGISTRY` and `IMAGE_REPOSITORY` and the protected secrets `REGISTRY_USERNAME` and `REGISTRY_PASSWORD`; publishing fails closed when any registry coordinate or credential is absent. Retrieve `release-manifest.json` and verify its source commit, archive SHA-256, repository, and registry digest.
3. Configure each protected deployment environment with `KUBECONFIG_CONTENT` and a complete `HELM_VALUES` Secret. Run **Promote or roll back immutable gateway image** with the trusted publish run ID, source commit, release, and namespace. It downloads the trusted manifest, inspects the remote digest, renders with the protected values, and—when that environment enables deployment—uses the same values with Helm `--atomic --wait` without rebuilding or retagging.
4. Verify rollout, readiness, active connections, abnormal closes, queue drops, handler latency, Redis errors, and edge 5xx. Attach workflow evidence and a dashboard snapshot to the release record.

For rollback, run the same workflow with `operation=rollback` and the previously recorded digest. This changes only the selected digest. If automation is unavailable, use `scripts/Deploy-Realtime.ps1` with its explicit context guard and rollback action.

## Alert triage

| Alert | Immediate checks | Recovery |
| --- | --- | --- |
| Gateway unavailable/readiness | Prometheus target, pod events, readiness JSON, Redis subscription | Restore dependency, configuration, or capacity; roll back if correlated with rollout |
| Crash looping/restarts | Previous logs, termination reason, limits, configuration | Correct configuration/resources or roll back |
| Abnormal disconnects/heartbeat | Close codes, edge timeout, rollout, client network | Stabilize edge/pods; confirm reconnect advice and backoff |
| Authentication/authorization | Method/outcome, operation, identity-store health, clock skew | Restore stores or origin/audience configuration; investigate abuse without identity labels |
| Queue drops/slow consumers | Queue depth, fan-out, latency, CPU/memory | Shed abusive load, scale, tune reviewed limits, or disconnect slow consumers |
| Handler latency | p50/p95/p99, throttling, Redis and edge latency | Scale, remove dependency bottleneck, or roll back |
| Redis errors | Subscription, Sentinel primary, replication, persistence | Fail over through the managed topology, restore connectivity, verify recovery |
| Certificate expiry | Certificate events, issuer, challenge | Repair renewal and verify Secret/edge reload |
| Edge errors | Traefik metrics/logs, endpoints, MetalLB | Restore endpoints, configuration, or advertisement; validate upgrade |

Alert routing uses configurable `team` and `service` labels. The optional receiver uses an existing Secret key. In nonproduction, test both firing and resolved notifications with a short-lived threshold, then restore the source-controlled rule.

## Troubleshooting sequence

1. Establish scope with environment, cluster, namespace, instance, and pod variables.
2. Check scrape availability and readiness before interpreting an empty panel.
3. Correlate connection/message/queue symptoms with Redis, pod, edge, MetalLB, and certificate panels over the same interval.
4. Follow configured log and trace links and search by time/correlation ID. Never add correlation IDs to metric labels.
5. Compare the deployed digest with promotion evidence. Roll back when onset aligns with a digest change and recovery is safer than live repair.

## Redis and durable delivery recovery

Use Sentinel to identify the writable primary; do not redirect clients around the configured topology. Verify replication health and persistence before failover. Pub/Sub messages are ephemeral and cannot be replayed. For durable Streams, confirm pending counts, claim idle threshold, completion markers, acknowledgements, poison entries, and consumer recovery. Use lifecycle backup/restore actions only with an explicit context and validated backup artifact.

## Certificates, edge, scaling, and capacity

- Certificates: alert seven days before expiry; verify renewal, Secret update, and edge reload.
- Edge/MetalLB: verify WebSocket upgrade, 4xx/5xx, endpoints, advertised address, and stale configuration. Addresses and selectors come from deployment configuration.
- Scaling: retain raw load JSON and dashboard snapshots. Select minimum replicas from measured peak plus one failure-domain reserve. CPU 70% and memory 75% are initial HPA guardrails, not capacity claims.
- Soak: run at least six hours through a production-equivalent nonproduction topology; compare start/end memory, reconnects, queue depth, Redis resources, restarts, and latency.

## Fault-injection checklist

Perform only in an approved nonproduction environment with rollback evidence prepared:

1. Delete one gateway pod and confirm drain/reconnect, readiness, and no sustained errors.
2. Restart/fail over Redis and confirm subscription recovery, bounded errors, and durable recovery where enabled.
3. Remove one gateway endpoint from edge routing and confirm remaining replicas serve upgrades.
4. Apply CPU pressure and verify alert/HPA scale-up, then controlled scale-down.
5. Use a short-lived test rule to validate certificate notification routing.
6. Promote a tested digest, then roll back to the recorded prior digest and compare evidence.

Record timestamps, immutable digests, configured targets, expected/observed signals, recovery time, data-loss semantics, and follow-ups. Stop immediately if a test escapes the approved namespace or threatens shared dependencies.
