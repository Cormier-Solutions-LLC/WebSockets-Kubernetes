# Local development baseline

Captured 2026-08-30 with the repository load harness (`scripts/Invoke-RealtimeLoad.ps1` -> `tools/Cormier.Realtime.LoadRunner`, `schemaVersion: 2`). This validates local harness behavior and provides a regression reference; it is not a production-capacity claim.

| Scenario | Connections | Messages | Payload | Duration | Operations/s | Connection p50/p95/p99 | Acknowledged publish p50/p95/p99 | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| burst | 25/25 | 2,500 sent/2,500 acknowledged | 512 B | 1.146 s | 2,181.331 | 88.615/89.314/113.016 ms | 8.647/11.808/18.573 ms | 0 |
| connection | 5/5 | 0 publishes; held 3.187 s | 64 B | 3.187 s | 0 | 76.924/117.008/117.008 ms | n/a | 0 |
| fanout | 3/3 | 15 sent/15 acknowledged/45 events delivered | 128 B | 0.298 s | 50.308 | 61.714/84.562/84.562 ms | 5.836/6.352/6.352 ms | 0 |

Interpretation from the retained results:

- `requestedConnections == establishedConnections` in each scenario.
- `messagesSent == messagesReceived` for burst/fanout acknowledgements.
- Fanout delivery expectation (`messagesSent * establishedConnections`) was fully drained (45/45).
- `errorCount == 0` in every scenario.

Reproduction notes (all environment values are caller supplied and must stay configurable):

```powershell
./scripts/Invoke-RealtimeLoad.ps1 -Endpoint $webSocketEndpoint -Origin $allowedOrigin -SessionId $testSession -Scenario burst -Connections 25 -MessagesPerConnection 100 -PayloadBytes 512 -DurationSeconds 60 -OutputPath artifacts/load/local-burst.json
./scripts/Invoke-RealtimeLoad.ps1 -Endpoint $webSocketEndpoint -Origin $allowedOrigin -SessionId $testSession -Scenario connection -Connections 5 -MessagesPerConnection 0 -PayloadBytes 64 -DurationSeconds 3 -OutputPath artifacts/load/local-connection.json
./scripts/Invoke-RealtimeLoad.ps1 -Endpoint $webSocketEndpoint -Origin $allowedOrigin -SessionId $testSession -Scenario fanout -Connections 3 -MessagesPerConnection 5 -PayloadBytes 128 -DurationSeconds 60 -OutputPath artifacts/load/local-fanout.json
```

Production thresholds and HPA decisions still require the six source-controlled scenarios in [`load/profiles/production-readiness.json`](../profiles/production-readiness.json) (`connection`, `fanout`, `burst`, `large-message`, `slow-client`, `soak`) against a production-equivalent nonproduction cluster, plus saved platform dashboard evidence as described in [`load/README.md`](../README.md).
