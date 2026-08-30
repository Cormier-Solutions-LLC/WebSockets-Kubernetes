# Local development baseline

Measured 2026-08-30 with the Release framework-dependent gateway, Redis 7.4 Alpine in Docker, and the load runner on the same Windows development workstation. This validates the harness and establishes a regression reference; it is not a production capacity claim.

| Scenario | Connections | Messages | Payload | Duration | Operations/s | Send p50/p95/p99 | Errors | Final queue depth/drops |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| burst | 25/25 | 2,500 sent/2,500 received | 512 B | 9.332 s | 270.582 | 0.500/0.991/3.857 ms | 0 | 0/0 |

The maximum observed client operation was 202.178 ms during connection establishment. All requested connections established, every acknowledgement was drained, and post-run gateway metrics reported no retained queue entries or queue drops. Production thresholds and HPA decisions require the six source-controlled scenarios against a production-equivalent nonproduction cluster, including the six-hour soak and saved platform dashboard evidence.
