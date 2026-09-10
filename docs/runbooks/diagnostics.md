# Secure diagnostics operations

The diagnostics API is an operator-only, live troubleshooting surface. It is disabled by default and is not a historical log archive or a replacement for the metrics backend. The API contract is versioned at `/diagnostics/v1`; configure all paths, origins, networks, policies, and collector endpoints for each environment.

## Enablement and access

Set `Diagnostics__Enabled=true`, a registered `Diagnostics__AuthorizationPolicy`, at least one `Diagnostics__AllowedNetworks__N` CIDR, and every browser origin as `Diagnostics__AllowedOrigins__N`. Production also requires the separate acknowledgement `Diagnostics__ProductionEnabled=true`. Keep the API behind TLS, an operator identity provider, a dedicated ingress route, and a Kubernetes NetworkPolicy. Do not expose it through the public application route.

The standalone gateway can register its built-in bearer policy from a strong `Diagnostics__OperatorToken` supplied only at runtime. The Helm chart maps this value from `diagnostics.operatorTokenSecret`, which must reference an existing Secret. Package consumers may call `AddRealtimeDiagnosticsBearer(policyName, token)` or register a custom operator policy backed by their identity provider. Rotate a bearer token by updating the Secret and restarting the Deployment; active requests keep no server-side token session.

The authorization policy must identify the operator and reject ordinary application identities. Requests without a valid policy identity fail before a handler runs. Requests from a disallowed network or browser Origin receive `403`. An empty Origin is permitted for non-browser operator tools, but it does not bypass policy or network checks.

Emergency disablement is `Diagnostics__Enabled=false` followed by a normal rollout. This removes all diagnostics routes. Existing live streams end with their pod. Removing the dedicated ingress/NetworkPolicy rule is the network-level fallback.

## Supported workflow

- `GET /diagnostics/v1/snapshot` returns a cheap, aggregate snapshot: build, uptime, instance, readiness/drain, connection/subscription/queue/message/Redis state, memory, CPU, and active logging overrides.
- `GET /diagnostics/v1/connections?offset=0&limit=25` returns capped per-connection timing and counts. Connection references are one-way hashes; tenant, user, session, ticket, topic, and payload values are never returned.
- `GET /diagnostics/v1/events?durationSeconds=300` streams versioned aggregate operational events as server-sent events.
- `GET /diagnostics/v1/logs/tail?level=Warning&category=Cormier.Realtime&durationSeconds=300` tails new log records only. Optional `instance` and `correlation` filters are exact matches. There is no historical-download endpoint.
- `POST /diagnostics/v1/logging/overrides` applies a temporary capture-level change. Supply `category`, `level`, `durationSeconds`, `reason`, and `scope` (`all` or `instance`).
- `DELETE /diagnostics/v1/logging/overrides/{id}` rolls an active override back. `GET /logging/overrides` and `GET /logging/audit` show active and bounded audit state.

Example request body:

```json
{
  "category": "Cormier.Realtime.Redis",
  "level": "Debug",
  "durationSeconds": 300,
  "reason": "investigate elevated publish latency",
  "scope": "all"
}
```

Categories must match `Diagnostics__LogCategoryAllowlist`; `None`, unknown levels, unbounded durations, missing reasons, and invalid scopes are rejected. Replica-wide changes are written with a Redis TTL and published to every instance. If Redis is unavailable, a replica-wide request fails with `503`; use an explicitly scoped `instance` change only when the incident commander accepts incomplete coverage. Overrides expire automatically and are restored after a replica restart while the Redis TTL remains active.

## Bounds and redaction

Snapshot/detail concurrency, result size, live-stream sessions, per-client buffers, event rate, byte rate, and duration are all bounded by `Diagnostics__*` settings. A slow stream retains only its bounded window; a rate violation receives a `disconnect` event and closes. Clients must reconnect and reauthorize after interruption or pod churn.

Redaction occurs before a log event enters the live hub. Authorization/cookie headers, bearer values, passwords, secrets, tokens, connection tickets, and tenant/user/session values are replaced. Log messages are length-capped. Do not put message payloads or credentials in log templates; redaction is defense in depth, not permission to log sensitive data.

## Metrics and normal ranges

Prometheus 0.0.4 and OpenMetrics 1.0 are negotiated on the configured `Metrics__Path` (default `/metrics`). Gzip is supported through response compression. Restrict the scrape path with `Metrics__AuthorizationPolicy`, `Metrics__AllowedNetworks`, TLS at the edge, and NetworkPolicy as required. Enable OTLP with `Metrics__OtlpEnabled=true`; endpoint, protocol, headers, compression, timeout, TLS, and resource settings use standard `OTEL_*` variables. Secret OTLP headers must come from a Secret, never a ConfigMap or values file.

The machine-readable source of truth is [`observability/metrics-catalog.json`](../../observability/metrics-catalog.json). Snapshots update per request, operational events publish bounded state transitions and a once-per-second aggregate sample, scrapes observe at scrape time, and OTLP observes at its configured export interval. `message.throughput` maps to the message counter/rate, connection/subscription/queue/Redis/drain event kinds map to their like-named gauges and counters, and the snapshot's message rate is the process-lifetime average. Those freshness and aggregation differences are expected; names, types, units, bounded dimensions, and counter/gauge meaning must agree.

Normal values depend on the load baseline, but these invariants always apply:

- queue depth should return toward zero and remain below the configured alert threshold;
- Redis subscription state should be `1` for every ready replica;
- draining should be `0` outside rollouts and `1` only while that replica rejects new work;
- authentication/authorization, queue-drop, abnormal-close, and Redis-error rates should remain near zero;
- a counter reset accompanied by a changed pod/process identity is expected after restart.

## Troubleshooting and rollback

1. Confirm policy identity, Origin, source network, TLS, and the configured base path before changing controls.
2. Compare the snapshot with `/metrics`, the operational event stream, and the dashboard. Account for the one-second event interval and scrape/export intervals.
3. For Redis interruption, expect readiness/subscription degradation, failed replica-wide controls, and bounded exporter retries; existing local overrides still expire.
4. For a slow tail client, reduce filters and reconnect. Never raise the server limits during an incident without a capacity review.
5. Roll back a logging override by ID or wait for expiry. Verify the audit outcome is `reverted` or `expired` on each intended instance. Redis-backed audit entries are capped and expire after `Diagnostics__AuditRetentionDays`; the central log backend owns longer retention.
6. Roll back telemetry by disabling OTLP first, then reverting collector configuration. The scrape path remains independent.
7. Preserve evidence from the central metrics/log backend and the bounded audit response. The live API deliberately cannot export historical logs.

Collector examples live in `observability/prometheus.example.yaml` and `observability/otel-collector.example.yaml`. Substitute environment configuration and Secret-backed headers before use.
