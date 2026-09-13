# Production-readiness load testing

`scripts/Invoke-RealtimeLoad.ps1` runs `tools/Cormier.Realtime.LoadRunner/Cormier.Realtime.LoadRunner.csproj` with caller-supplied endpoint, origin, session ID, session-cookie name, subprotocol, topic, concurrency, duration, and output path. Supported scenarios are `connection`, `fanout`, `burst`, `large-message`, `slow-client`, and `soak` (matching `profiles/production-readiness.json`). The harness sets `CORMIER_LOAD_SESSION_ID` from `-SessionId`, so no production address, credential, or secret is stored in this repository.

Each connection uses an asynchronous receive loop and workload task. The result JSON reports connection latency and acknowledged publish latency separately, and the `connection` scenario sends periodic `ping` commands for the full configured duration.

Use an isolated test tenant/session and capture a Grafana snapshot covering the run. Start with the profile in `profiles/production-readiness.json`, then increase connections in 25% steps until one measured guardrail is crossed:

- handler p99 above 250 ms for ten minutes;
- any queue drop or slow-consumer disconnect outside the intentional slow-client scenario;
- CPU above 70% or memory above 75% of the pod limit for ten minutes;
- Redis operation error rate above zero or Redis command p99 above 10 ms;
- more than 0.1% abnormal connection closes.

Record Kubernetes version, node/pod resources, replicas, image digest, Redis topology, profile, results JSON, and dashboard snapshot in the release evidence. Keep these thresholds aligned with the operational scaling guidance in [`docs/runbooks/README.md`](../docs/runbooks/README.md).

Retained baseline evidence for harness validation is tracked in [`results/local-baseline.md`](results/local-baseline.md); it is a local regression reference, not a production capacity claim.

Example (all environment identities remain caller supplied):

```powershell
./scripts/Invoke-RealtimeLoad.ps1 -Endpoint $webSocketEndpoint -Origin $allowedOrigin -SessionId $testSession -Scenario burst -Connections 250 -MessagesPerConnection 1000 -OutputPath artifacts/load/burst.json
```
