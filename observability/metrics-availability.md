# Metric availability and ownership

| Diagnostic area | Source | Availability |
| --- | --- | --- |
| Connections, handshakes, authn/authz, closes, heartbeat | Gateway `/metrics` | Always available when scraped |
| Message outcomes, handler latency, queue depth/drops, slow consumers | Gateway `/metrics` | Always available when scraped |
| Redis publish/subscribe/stream operation outcomes | Gateway `/metrics` | Always available when exercised |
| Redis resource, client, replication, persistence, command latency | Redis exporter | Requires the managed Redis metrics sidecar or an equivalent external exporter |
| Stream pending, consumer lag, and failover duration | Redis exporter/recording rules | Exporter-dependent; validate metric names before enabling panels or alerts |
| Pod CPU, memory, throttling, restarts, readiness, rollout | kubelet/cAdvisor and kube-state-metrics | Requires the platform monitoring stack |
| Traefik upgrades, open connections, 4xx/5xx, latency | Traefik Prometheus metrics | Requires Traefik metrics and ServiceMonitor integration |
| MetalLB announcements, allocation, stale configuration | MetalLB Prometheus metrics | Requires MetalLB metrics integration |
| Certificate readiness and expiry | cert-manager metrics | Requires cert-manager metrics integration |
| Logs and traces | Configured dashboard links | Collector/vendor-neutral; URLs are Helm values |

Unavailable series render as no data rather than zero. Operators must not interpret a blank platform panel as healthy. During installation, use the dashboard links and Prometheus target page to verify each exporter, then disable unsupported panels or add site-specific recording rules without introducing tenant-level labels.
