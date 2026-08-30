# Architecture

## Independence boundary

`Propago.Realtime.Gateway` is a standalone process and deployable artifact. It does not reference or run inside the PBV7 application. The solution separates protocol contracts, Redis infrastructure, hosting, and four verification suites so each concern can evolve without coupling release lifecycles.

## Project responsibilities

- **Gateway** owns the WebSocket endpoint, local connection registry, dispatch and authorization, lifecycle state, health endpoints, structured JSON logs, metrics, and traces.
- **Contracts** owns transport DTOs and the source-generated `System.Text.Json` context required for trimming and Native AOT.
- **Redis** owns reconnecting connections, session and single-use ticket validation, namespaced Pub/Sub, and optional durable Streams.
- **Tests** separate fast unit checks, in-process HTTP integration checks, Kubernetes contract checks, and load-harness contracts.

## Health model

Startup, liveness, and readiness have deliberately different meanings:

1. Startup becomes healthy when the host has finished starting.
2. Liveness means the process can answer requests and does not depend on Redis or downstream services.
3. Readiness requires startup completion, a non-draining host, and successful registered dependency probes.

Kubernetes must remove the pod from ready endpoints before shutdown. PBV7-486 extends the draining state to active WebSocket connections; PBV7-487 supplies the probes and termination configuration.

## Connection and messaging model

Every gateway owns its live WebSocket objects, subscription set, correlation history, and bounded outbound queues in local memory. Redis stores authentication state and messaging data only. A Pub/Sub subscriber on each gateway filters every received event by server-derived tenant, current user when applicable, and local subscription before enqueueing it.

Pub/Sub is lossy real-time fan-out. Optional Streams are an independent at-least-once path for an explicit allowlist of durable event classes. Consumer groups acknowledge completed work, reclaim idle pending entries after a crashed consumer, use expiring idempotency markers, and quarantine malformed entries in a bounded poison stream.

## Native AOT constraints

- HTTP DTOs must be registered with `RealtimeJsonSerializerContext`.
- Runtime reflection and dynamic JSON serialization are not allowed on protocol paths.
- AOT and trimming warnings are build failures.
- The runtime image uses the chiseled .NET runtime-deps base and UID 1654.
- Kubernetes will enforce read-only filesystem and remaining pod security controls in PBV7-487.

## Versioning

`Directory.Build.props` defines independent `ApplicationVersion`, `ContainerVersion`, `ContractsVersion`, `RedisAdapterVersion`, and `HelmChartVersion` properties. Each product artifact consumes only its corresponding property, so contract, application, container-only, Redis adapter, and chart releases can advance without forcing unrelated version changes. All five streams begin at semantic version `0.1.0` and can be overridden independently by release automation. Immutable release identifiers may append source revision metadata without changing the semantic compatibility contract.
