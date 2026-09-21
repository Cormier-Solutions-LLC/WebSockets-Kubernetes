# Architecture

## Deployment and hosting boundary

`Cormier.Realtime.Gateway` is a standalone ASP.NET Core process and Native AOT deployable. It composes the reusable `Cormier.Realtime.AspNetCore` package, adds the health endpoints and standalone diagnostics/metrics authentication helpers, and supplies JSON console logging. It has no dependency on a customer application.

Applications that need the same realtime capability in an existing ASP.NET Core process can reference `Cormier.Realtime.AspNetCore` and call `AddRealtimeGateway`, `UseRealtimeGateway`, and `MapRealtimeGateway`. The host remains responsible for its HTTP pipeline, session integration, authorization policies, configuration providers, and deployment lifecycle.

Both hosting modes use the same protocol, Redis, diagnostics, metrics, and configuration contracts. Deployment names, network identities, trust boundaries, and Secret names are supplied at runtime rather than encoded in the application.

## Component responsibilities

- **`Cormier.Realtime.Contracts`** owns the wire envelopes, health and ticket DTOs, Redis records, durable messages, protocol validation, and source-generated `System.Text.Json` context. It targets .NET Standard 2.0 and .NET 10.
- **`Cormier.Realtime.Redis`** owns the reconnecting Redis connection, session lookup, atomic single-use ticket issue/consume flow, namespaced Pub/Sub, and optional durable Streams store.
- **`Cormier.Realtime.AspNetCore`** owns service registration, option validation, middleware and endpoint mapping, authentication resolution, connection lifecycle, dispatch and authorization, local connection state, Redis subscription, metrics, OpenTelemetry, diagnostics, and graceful drain behavior.
- **`Cormier.Realtime.Gateway`** is the standalone composition root and lifecycle host.
- **`Cormier.Realtime.Client`** is the .NET Standard 2.0 client, including transport abstraction, authentication refresh, bounded queues, request correlation, heartbeats, reconnect, and subscription restoration.
- **`sdk/typescript`** is the canonical TypeScript/browser client and deterministic ESM/IIFE asset pipeline. **`Cormier.Realtime.Browser`** packages those browser artifacts for ASP.NET Core consumers.
- **Helm, bootstrap, cluster, observability, and load assets** turn the runtime contracts into validated deployment plans, Kubernetes resources, telemetry, runbooks, and repeatable test workloads.
- **Tests and examples** verify unit behavior, the hosted HTTP/WebSocket system, .NET clients, Kubernetes/rendered contracts, load-harness behavior, clean package consumers, browsers, and alternative server stacks.

The dependency direction is inward: hosts and clients depend on the public contracts; ASP.NET Core hosting depends on the contracts and Redis adapter; the standalone gateway depends on the hosting package. Deployment and test tooling consume those outputs without becoming runtime dependencies.

## Connection and authentication flow

1. The client connects to the configured WebSocket endpoint using the `cormier.realtime.v1` subprotocol.
2. The gateway resolves a server-controlled session identifier from the configured cookie or ASP.NET Core session source, or consumes a short-lived connection ticket. Query-string tickets are intended for clients that cannot send the session cookie and are redacted from application logging paths.
3. Redis supplies the session/ticket identity, tenant, user, allowed topics, expiry, and revocation state. A ticket is audience-bound and atomically consumed once.
4. The gateway registers the socket locally and periodically revalidates the authenticated session. Expired, revoked, invalid, or unavailable authentication closes the connection with a protocol-defined reason.
5. Incoming envelopes are size- and shape-validated before dispatch. Authorization uses the server-derived identity; client-supplied tenant or user fields never expand access.

The gateway applies exact origin rules and trusted-proxy configuration before accepting credentials. TLS termination, external identity, and ingress policy remain deployment responsibilities. The [protocol contract](protocol.md) defines envelopes, message types, limits, close codes, authentication, and reconnect behavior.

## State and messaging model

Every gateway replica owns its live WebSocket objects, local subscriptions, bounded outbound queues, and bounded correlation history in memory. This state is intentionally not transferred between replicas. A reconnect creates a new connection and clients restore their desired subscriptions without duplicating them.

Redis holds shared authentication and messaging state beneath a configurable instance prefix:

- Pub/Sub provides low-latency cross-replica fan-out. Each replica filters a received event by the server-derived tenant, optional user scope, and local subscriptions before enqueueing it. Pub/Sub is ephemeral and cannot replay missed messages.
- Streams are an independent opt-in, at-least-once path for an explicit allowlist of durable event classes. Consumer groups acknowledge completed work, reclaim sufficiently idle pending entries, write expiring idempotency markers only after successful side effects, and move malformed entries to a bounded poison stream.
- Session and ticket records are validated before use. Ticket consumption is atomic, and all keys and channels remain scoped to the configured instance prefix.

Backpressure is bounded at the connection queue. Repeated slow-consumer overflow closes that connection instead of allowing unbounded memory growth. Frame size, assembled-message size, subscriptions, correlations, queue capacity, heartbeats, and idle timeouts are all validated configuration.

## Health and lifecycle model

Startup, liveness, and readiness deliberately answer different questions:

1. `/health/startup` becomes healthy after the host has completed startup.
2. `/health/live` reports process liveness and does not depend on Redis or downstream services.
3. `/health/ready` requires startup completion, a host that is not draining, and an active Redis subscription. When `Redis:RequiredForReadiness` is enabled, the Redis readiness probe must also succeed.

On shutdown, readiness becomes unavailable before the configured drain interval. Existing sockets receive a restart notice, new work is rejected, and remaining sockets close when draining completes. The Helm chart's termination grace period exceeds the application shutdown timeout so Kubernetes can remove the pod from ready endpoints before process termination.

## Observability and diagnostics

The hosting package records bounded-cardinality gateway, connection, message, authentication, authorization, queue, Redis, handler, and lifecycle metrics. It exposes Prometheus/OpenMetrics text output and can export metrics through OpenTelemetry OTLP. Service, version, topology, environment, cluster, namespace, and instance dimensions come from controlled configuration and resource attributes.

Diagnostics are disabled by default. When enabled they expose bounded snapshots, connection/event streams, log tailing, and time-limited log-level overrides with audit and Redis-backed coordination. Production enablement, authorization policy, bearer credential, allowed origins, and allowed networks are independent controls. Protected metrics use a distinct policy and credential. See the [diagnostics runbook](runbooks/diagnostics.md) and [observability contract](../observability/README.md).

## Deployment topology

The versioned bootstrap schema selects `non-ha` or `ha` explicitly and renders gateway values plus managed-Redis overrides when managed Redis is selected:

- `non-ha` uses one gateway, no autoscaler or disruption budget, and standalone managed Redis when selected. Interruptions and rolling updates can cause downtime.
- `ha` requires at least three schedulable failure domains. It uses three initial gateway replicas, a two-available disruption budget, zone/host spreading, autoscaling, and a zero-unavailable rollout. Managed Redis uses replication and Sentinel; external Redis requires an explicit operator confirmation that it is highly available.

The Helm workload runs as non-root UID/GID 1654, drops all capabilities, disables privilege escalation, uses the runtime-default seccomp profile and a read-only root filesystem, mounts a bounded writable `/tmp`, and does not automatically mount a service-account token. NetworkPolicy restricts ingress and Redis, DNS, monitoring, and optional OTLP traffic according to explicit selectors and CIDRs.

Secrets are referenced from existing Kubernetes Secrets and injected at runtime. Bootstrap configuration, generated values, backups, and logs may contain environment identity but must not contain credential values. The [bootstrap guide](bootstrap.md) and [cluster guide](../cluster/README.md) define planning, topology conversion, backup, rollback, recovery, and teardown behavior.

## Native AOT and supply-chain constraints

- Protocol and HTTP DTOs must use `RealtimeJsonSerializerContext`; runtime reflection and unregistered dynamic JSON are not allowed on Native AOT paths.
- Compiler, analyzer, trimming, and AOT warnings fail the build.
- The gateway publishes on the chiseled .NET 10 runtime-deps base as UID 1654 and disables runtime diagnostics in the container.
- CI restores locked dependencies, verifies deterministic client/package outputs, tests clean consumers, scans source and images, smoke-tests a rootless read-only container, and emits SBOM and immutable release evidence.
- Publication and promotion operate on previously tested artifacts. Promotion verifies source commit, archive checksum, registry/repository, credential provider, and immutable digest rather than rebuilding.

## Versioning

`Directory.Build.props` defines independent release inputs for the gateway application, container, Contracts, Redis adapter, ASP.NET Core integration, .NET client, browser package, and Helm chart. Each .NET project consumes only its corresponding application, container, or package property, allowing compatible artifacts to advance without forcing a single shared version. The TypeScript/npm version is maintained in `sdk/typescript/package.json` and must match the browser package version during the coordinated package build. The chart's source `version` and `appVersion` are maintained in `helm/realtime-gateway/Chart.yaml`.

The current NuGet package and npm defaults are `1.0.0-beta`; the gateway application and container remain `0.1.0`, and the chart source version is currently `0.2.0` with application version `0.1.0`. Release automation may override release inputs and append source revision metadata where supported. Compatibility ranges, deterministic candidate construction, immutable evidence, publication, promotion, and rollback are defined in the [package release policy](package-release.md).
