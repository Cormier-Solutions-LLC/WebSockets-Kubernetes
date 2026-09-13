# Cormier Realtime gateway observability

The `helm/realtime-gateway` chart can emit observability resources from values under `observability`:

- `ServiceMonitor` when `metrics.enabled` and `observability.serviceMonitor.enabled` are both true and the `monitoring.coreos.com/v1/ServiceMonitor` CRD is available.
- `PrometheusRule` when `metrics.enabled` and `observability.prometheusRule.enabled` are both true and the `monitoring.coreos.com/v1/PrometheusRule` CRD is available.
- Grafana dashboard `ConfigMap` when `observability.grafanaDashboard.enabled` is true.
- Optional `AlertmanagerConfig` when `observability.alertmanagerConfig.enabled` is true and the `monitoring.coreos.com/v1alpha1/AlertmanagerConfig` CRD is available.

`AlertmanagerConfig` webhook routing always references an existing Secret (`observability.alertmanagerConfig.webhookSecret`) and does not store notification URLs in chart values.

The portable metrics contract is defined in [`metrics-catalog.json`](metrics-catalog.json). It is the compatibility source for Prometheus/OpenMetrics and OTLP metric exports used by diagnostics, dashboards, and alerts. `prometheus.example.yaml` provides an operator-neutral pull scrape example. `otel-collector.example.yaml` provides bounded OTLP/Prometheus receive, private-attribute filtering, batch processing, and Secret-sourced exporter headers.

The conformance fixtures in [`conformance/`](conformance/) and [`scripts/verify-observability.sh`](../scripts/verify-observability.sh) validate gateway OTLP export through a collector into both an OTLP receiver and Prometheus, including collector interruption/recovery and shutdown flush behavior.

Enable OTLP with `Metrics__OtlpEnabled=true` (or `observability.otlp.enabled=true` in Helm values) plus standard `OTEL_EXPORTER_OTLP_*` settings.

Catalog changes follow semantic compatibility rules from `metrics-catalog.json`:

- additive optional series or bounded label values: minor version;
- renames/removals/type-unit-label changes: major version;
- removals require at least one minor release with an alias, warning, and changelog entry.

The dashboard intentionally supports only bounded operational variables: `environment`, `cluster`, `namespace`, `instance`, and `pod`. Tenant, user, topic, route, correlation ID, and other workload identifiers are intentionally excluded from metric labels and dashboard variables. Use access-controlled logs or traces for single-request investigations.

Platform panels and alerts are configurable and exporter-dependent. In particular:

- Redis platform panels use exporter metrics keyed by `observability.platformMetrics.redisNamespace` and `observability.platformMetrics.redisInstance` (defaults are derived when unset).
- Edge, certificate, and MetalLB alerts are included only when `observability.prometheusRule.ingressEnabled=true`; certificate alerts also require `observability.platformMetrics.certificateName`.

CI and contract coverage currently validate this surface by:

- parsing dashboard variables and requiring exactly `environment`, `cluster`, `namespace`, `instance`, and `pod`;
- Helm lint/template checks for rendered ServiceMonitor/PrometheusRule/AlertmanagerConfig content;
- `promtool check rules` against rendered PrometheusRule output;
- contract tests for required dashboard queries, alert coverage, routing labels, runbook links, collector examples, and conformance assets;
- running `scripts/verify-observability.sh` in CI.

See [metric availability](metrics-availability.md), [load testing](../load/README.md), and [operations runbooks](../docs/runbooks/README.md).
