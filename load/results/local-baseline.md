# Local development baseline

Measured 2026-08-30 with the Native AOT Linux gateway, Redis 7.4 Alpine in Docker, and the concurrent .NET load runner on the same Windows development workstation. This validates the harness and establishes a regression reference; it is not a production capacity claim.

| Scenario | Connections | Messages | Payload | Duration | Operations/s | Connection p50/p95/p99 | Acknowledged publish p50/p95/p99 | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| burst | 25/25 | 2,500 sent/2,500 acknowledged | 512 B | 1.146 s | 2,181.331 | 88.615/89.314/113.016 ms | 8.647/11.808/18.573 ms | 0 |
| connection | 5/5 | 0 publishes; held 3.187 s | 64 B | 3.187 s | 0 | 76.924/117.008/117.008 ms | n/a | 0 |
| fanout | 3/3 | 15 sent/15 acknowledged/45 events delivered | 128 B | 0.298 s | 50.308 | 61.714/84.562/84.562 ms | 5.836/6.352/6.352 ms | 0 |

All requested connections established, the connection profile stayed open for its configured duration, every publish acknowledgement was correlated, and fanout drained all 45 expected deliveries before closing. Post-run gateway metrics reported zero active connections and no retained outbound queue series. Production thresholds and HPA decisions require the six source-controlled scenarios against a production-equivalent nonproduction cluster, including the six-hour soak and saved platform dashboard evidence.
