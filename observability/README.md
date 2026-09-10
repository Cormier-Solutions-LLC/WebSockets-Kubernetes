# Realtime gateway observability

The gateway chart provisions its own `ServiceMonitor`, Grafana dashboard ConfigMap, and `PrometheusRule`. Optional `AlertmanagerConfig` routing references an existing Secret; it never stores a notification URL in chart values. Configure dashboard links, monitor selector labels, routing labels, receiver/Secret names, and the runbook base URL under `observability` in Helm values.

The portable metrics contract is defined in [`metrics-catalog.json`](metrics-catalog.json). It is the compatibility source for Prometheus/OpenMetrics scrapes, OTLP exports, diagnostics snapshots/events, dashboards, and alerts. `prometheus.example.yaml` is the operator-neutral pull configuration; `otel-collector.example.yaml` demonstrates bounded receive/filter/batch/export processing with Secret-sourced environment variables. The `conformance/` fixtures and `scripts/verify-observability.sh` exercise gateway OTLP export through a collector into both an OTLP receiver and Prometheus, including exporter interruption, recovery, and shutdown flush. The chart emits a `ServiceMonitor` when the Prometheus Operator CRD is available; use the plain scrape example otherwise.

Enable OTLP with `Metrics__OtlpEnabled=true` and standard `OTEL_*` settings. Additive catalog changes increment the minor contract version. Renames, removals, type/unit changes, or label changes increment the major version and require a migration window, compatibility alias, deprecation warning, changelog entry, dashboard/alert update, and rollback instructions.

The dashboard supports only bounded operational variables: environment, cluster, namespace, instance, and pod. Tenant, user, topic, route, correlation ID, and other workload identifiers are intentionally excluded from metric labels and dashboard variables. Use access-controlled logs or traces for an individual request investigation.

CI parses the dashboard JSON, lints and renders the chart, and contract-tests required panels, alerts, links, safe variables, and routing. See [metric availability](metrics-availability.md), [load testing](../load/README.md), and [operations runbooks](../docs/runbooks/README.md).
