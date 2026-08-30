# Architecture

## Independence boundary

`Propago.Realtime.Gateway` is a standalone process and deployable artifact. It does not reference or run inside the PBV7 application. The solution separates protocol contracts, Redis infrastructure, hosting, and four verification suites so each concern can evolve without coupling release lifecycles.

## Project responsibilities

- **Gateway** owns hosting, configuration validation, lifecycle state, health endpoints, structured JSON logs, baseline metrics, and the future WebSocket endpoint.
- **Contracts** owns transport DTOs and the source-generated `System.Text.Json` context required for trimming and Native AOT.
- **Redis** owns configuration and readiness abstractions. The actual session and messaging implementation is intentionally delivered by PBV7-486.
- **Tests** separate fast unit checks, in-process HTTP integration checks, Kubernetes contract checks, and load-harness contracts.

## Health model

Startup, liveness, and readiness have deliberately different meanings:

1. Startup becomes healthy when the host has finished starting.
2. Liveness means the process can answer requests and does not depend on Redis or downstream services.
3. Readiness requires startup completion, a non-draining host, and successful registered dependency probes.

Kubernetes must remove the pod from ready endpoints before shutdown. PBV7-486 extends the draining state to active WebSocket connections; PBV7-487 supplies the probes and termination configuration.

## Native AOT constraints

- HTTP DTOs must be registered with `RealtimeJsonSerializerContext`.
- Runtime reflection and dynamic JSON serialization are not allowed on protocol paths.
- AOT and trimming warnings are build failures.
- The runtime image uses the chiseled .NET runtime-deps base and UID 1654.
- Kubernetes will enforce read-only filesystem and remaining pod security controls in PBV7-487.

## Versioning

The application and initial OCI artifact use semantic version `0.1.0`. Contracts, application, image, and the future Helm chart can advance independently once their release pipelines split. Immutable release identifiers may append source revision metadata without changing the semantic compatibility contract.
