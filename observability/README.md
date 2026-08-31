# Realtime gateway observability

The gateway chart provisions its own `ServiceMonitor`, Grafana dashboard ConfigMap, and `PrometheusRule`. Optional `AlertmanagerConfig` routing references an existing Secret; it never stores a notification URL in chart values. Configure dashboard links, monitor selector labels, routing labels, receiver/Secret names, and the runbook base URL under `observability` in Helm values.

The dashboard supports only bounded operational variables: environment, cluster, namespace, instance, and pod. Tenant, user, topic, route, correlation ID, and other workload identifiers are intentionally excluded from metric labels and dashboard variables. Use access-controlled logs or traces for an individual request investigation.

CI parses the dashboard JSON, lints and renders the chart, and contract-tests required panels, alerts, links, safe variables, and routing. See [metric availability](metrics-availability.md), [load testing](../load/README.md), and [operations runbooks](../docs/runbooks/README.md).
