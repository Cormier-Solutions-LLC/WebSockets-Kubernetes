# Realtime gateway operations runbooks

All commands require explicit context, namespace, release, and endpoint parameters. Never copy a production address, credential, or Secret value into this repository or an incident ticket.

For the operator-only live troubleshooting surface, temporary log-level controls, redaction limits, and portable telemetry rollback, see [secure diagnostics operations](diagnostics.md).

## Deployment, promotion, and rollback

1. Confirm CI passed build, tests, Native AOT smoke, rootless/read-only container smoke, dependency review, Trivy scans, and SBOM generation.
2. Configure the repository variables `CONTAINER_REGISTRY`, `IMAGE_REPOSITORY`, and `REGISTRY_CREDENTIAL_PROVIDER`. Set the selected provider's independent trust-boundary variable to the same registry hostname: `GHCR_PUBLISH_REGISTRY`, `HARBOR_PUBLISH_REGISTRY`, `DOCKERHUB_PUBLISH_REGISTRY`, or `GENERIC_PUBLISH_REGISTRY`. Set the provider to `github` to use the workflow-scoped GitHub token, or to `harbor`, `dockerhub`, or `generic` and configure its corresponding protected publishing secret pair: `HARBOR_PUBLISH_USERNAME`/`HARBOR_PUBLISH_TOKEN`, `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`, or `REGISTRY_USERNAME`/`REGISTRY_PASSWORD`. Keep publish credentials separate from pull-request CI credentials. Publishing and promotion fail closed before login when the provider is unsupported, its trusted registry does not exactly match the artifact registry, or any registry coordinate or selected credential is absent. Retrieve `release-manifest.json` and verify its source commit, archive SHA-256, repository, credential provider, and registry digest. When promoting or rolling back a legacy schema-1 manifest, pass its original provider through `legacyCredentialProvider`; schema-2 manifests carry the provider in their trusted evidence.
3. Configure each protected deployment environment with `KUBECONFIG_CONTENT` and a complete `HELM_VALUES` Secret. Run **Promote or roll back immutable gateway image** with `publishRunId` and `sourceCommit` for promotion, or `rollbackPublishRunId` and `rollbackSourceCommit` for rollback, plus the explicit environment, release, and namespace. It downloads the trusted manifest, inspects the remote digest, renders with the protected values, and—when that environment enables deployment—uses the same values with Helm `--atomic --wait` without rebuilding or retagging.
4. Verify rollout, readiness, active connections, abnormal closes, queue drops, handler latency, Redis errors, and edge 5xx. Attach workflow evidence and a dashboard snapshot to the release record.

For rollback, run the same workflow with `operation=rollback` and the prior trusted publish run and source commit recorded for that digest. This changes only the selected digest. If automation is unavailable, use `scripts/Deploy-Realtime.ps1 -Action Rollback -Environment <environment> -Application <application> -ExpectedContext <kubernetes-context>`; the script derives the release and namespace as `<environment>-<application>` and rolls Helm back to the previous revision.

### Edge rollback procedure

Define every target from the release record; do not infer names or addresses from this example:

```powershell
$edgeContext = '<kubernetes-context>'
$edgeNamespace = '<gateway-namespace>'
$gatewayRelease = '<gateway-release>'
$traefikNamespace = '<traefik-namespace>'
$traefikRelease = '<traefik-release>'
$certificateName = '<certificate-name>'
$previousTlsSecret = '<last-known-good-tls-secret-name>'
$poolName = '<metallb-pool-name>'
$advertisementName = '<metallb-advertisement-name>'
```

Before a change, capture `helm history` for both releases and export the IngressRoute, Certificate metadata, IPAddressPool, advertisement, and LoadBalancer Service. Do not export Kubernetes Secret data. Record the current VIP, DNS answers, image digest, certificate serial/expiry, and external validation output.

Rollback one layer at a time in this order, stopping when service is healthy:

1. For an application regression, run the protected promotion workflow with `operation=rollback` and the prior trusted publish evidence for the recorded digest. With the CLI, run `Deploy-Realtime.ps1 -Action Rollback` with the explicit environment, application, and `$edgeContext`; first verify that its derived `<environment>-<application>` namespace and release both equal `$edgeNamespace` and `$gatewayRelease`. Wait for rollout and readiness before external validation.
2. For a route regression, restore the prior gateway Helm revision with `helm rollback $gatewayRelease <revision> --kube-context $edgeContext --namespace $edgeNamespace --wait`. Confirm the IngressRoute has only the approved host/path and references `$previousTlsSecret`.
3. For a certificate-reference regression, restore only the prior Secret name with a JSON patch; never copy certificate or private-key bytes through the command line. If issuance itself failed, restore the prior Certificate/Issuer manifest and wait for `Certificate` Ready before switching the route reference.
4. For a Traefik regression, restore the prior Traefik Helm revision with `helm rollback $traefikRelease <revision> --kube-context $edgeContext --namespace $traefikNamespace --wait`. Confirm three available replicas, the disruption budget, distinct-node placement, configured timeout arguments, and redacted access-log fields.
5. For a VIP regression, first withdraw the bad advertisement, then restore the prior IPAddressPool and L2/BGP advertisement as a unit. Never advertise the same pool through L2 and BGP concurrently. Confirm the LoadBalancer receives the recorded VIP, speakers are ready on eligible endpoint nodes, and DNS converges before removing the replacement pool.

After each rollback, run `Test-RealtimeEdge.ps1` with explicit context, namespaces, release/service names, host, path, external address/port, certificate trust source/key, MetalLB advertisement mode/name, metrics port when it cannot be derived, and expected client IP. Before a nonproduction failure test, label every namespace the selected scenario can mutate with matching `cormier.io/environment=<environment>`, `cormier.io/environment-class=nonproduction`, and `cormier.io/failure-testing=approved`; node drain requires the same three labels on the selected node and every namespace containing an evictable pod on that node. Remove approval labels when the test window closes. Run the matching `Invoke-RealtimeEdgeFailureTest.ps1` scenario to prove route, certificate, deployment, Traefik, speaker, and node recovery. Preserve its redacted evidence directory with the release record.

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
7. Remove all gateway backends and verify a bounded 502/503/504, restore replicas, and confirm routing recovers. Verify configured Traefik read/write/idle timeouts all exceed the gateway heartbeat, then keep an authenticated WSS connection active across multiple heartbeats.
8. Restart Traefik and one MetalLB speaker separately; verify distinct-node placement, VIP advertisement, observed source IP, and external route recovery after each event.

Record timestamps, immutable digests, configured targets, expected/observed signals, recovery time, data-loss semantics, and follow-ups. Stop immediately if a test escapes the approved namespace or threatens shared dependencies.
