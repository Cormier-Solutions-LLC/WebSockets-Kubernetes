# Realtime gateway Helm chart

`helm/realtime-gateway` is the versioned Cormier deployment chart. Release and namespace names use `<environment>-<application>`, such as `prod-realtime`; resource names derive from the release.

The chart creates a Deployment, ClusterIP Service, ConfigMap, ServiceAccount, PodDisruptionBudget, HorizontalPodAutoscaler, and NetworkPolicy. Pods run as UID/GID 1654, drop all capabilities, use a read-only root filesystem, do not mount service-account tokens, and expose separate probes.

Validate with Helm 4.2.0:

```powershell
helm lint ./helm/realtime-gateway --strict
helm template dev-realtime ./helm/realtime-gateway --namespace dev-realtime --values ./cluster/redis/managed-gateway-values.example.yaml
```

Production releases should pin `image.digest`, use namespace-specific ingress selectors, specify narrow Redis egress CIDRs/selectors, and supply pre-created Secrets. Managed gateway pods receive the release-specific Redis client label and discover the writable node through Sentinel. Use the lifecycle script for upgrades so Secret rotations force a gateway rollout. The chart never creates credentials.
