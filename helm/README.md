# Realtime gateway Helm chart

`helm/realtime-gateway` is the versioned Cormier deployment chart. Release and namespace names use `<environment>-<application>`, such as `prod-realtime`; resource names derive from the release.

The chart creates a Deployment, ClusterIP Service, ConfigMap, ServiceAccount, PodDisruptionBudget, HorizontalPodAutoscaler, and NetworkPolicy. Pods run as UID/GID 1654, drop all capabilities, use a read-only root filesystem, do not mount service-account tokens, and expose separate probes.

Validate with Helm 4.2.0:

```powershell
helm lint ./helm/realtime-gateway --strict
helm template dev-realtime ./helm/realtime-gateway --namespace dev-realtime --values ./cluster/redis/managed-gateway-values.example.yaml
```

Production releases should pin `image.digest`, use namespace-specific ingress selectors, specify narrow Redis egress CIDRs/selectors, and supply pre-created Secrets. Managed gateway pods receive the release-specific Redis client label and discover the writable node through Sentinel. Use the lifecycle script for upgrades so Secret rotations force a gateway rollout. The chart never creates credentials.

When OTLP export is enabled with NetworkPolicy enforcement, configure `observability.otlp.egressNamespaceSelector` (and optionally `egressPodSelector`) or explicit `egressCidrs`, plus the permitted `egressPorts`. The chart rejects OTLP enablement without a bounded egress destination.

Diagnostics remain disabled by default. To enable the built-in operator bearer policy, set `diagnostics.enabled=true`, explicitly opt in with `diagnostics.productionEnabled=true` for Production, configure narrow `allowedNetworks`/`allowedOrigins`, and set `diagnostics.operatorTokenSecret.name` to a pre-created Secret containing a strong token under the configured `key` (default `token`). Protected metrics require a separate pre-created Secret through `metrics.scrapeTokenSecret` whenever `metrics.authorizationPolicy` is set. Diagnostics and metrics must use distinct policy names and tokens. The chart reads both values through `secretKeyRef`; neither is placed in the ConfigMap. Rotate a Secret and restart the Deployment to replace its credential. For emergency disablement, set `diagnostics.enabled=false` and roll out the release.
