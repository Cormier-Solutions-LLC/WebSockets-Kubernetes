# Production-readiness load testing

`scripts/Invoke-RealtimeLoad.ps1` executes connection, fan-out, burst, large-message, slow-client, and soak scenarios against a configured deployment. Endpoint, origin, session cookie, topic, concurrency, duration, and output are parameters; the repository contains no production address or credential.

Use an isolated test tenant/session and capture a Grafana snapshot covering the run. Start with the profile in `profiles/production-readiness.json`, then increase connections in 25% steps until one measured guardrail is crossed:

- handler p99 above 250 ms for ten minutes;
- any queue drop or slow-consumer disconnect outside the intentional slow-client scenario;
- CPU above 70% or memory above 75% of the pod limit for ten minutes;
- Redis operation error rate above zero or Redis command p99 above 10 ms;
- more than 0.1% abnormal connection closes.

Record Kubernetes version, node/pod resources, replicas, image digest, Redis topology, profile, results JSON, and dashboard snapshot in the release evidence. Set HPA minimum replicas to the replicas required for ordinary peak load plus one failure-domain reserve; retain the 70% CPU and 75% memory targets and verify scale-up and scale-down with the same immutable image digest.

Example (all environment identities remain caller supplied):

```powershell
./scripts/Invoke-RealtimeLoad.ps1 -Endpoint $webSocketEndpoint -Origin $allowedOrigin -SessionId $testSession -Scenario burst -Connections 250 -MessagesPerConnection 1000 -OutputPath artifacts/load/burst.json
```
