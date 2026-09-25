# Realtime gateway Helm chart

`helm/realtime-gateway` is the versioned deployment chart for the Cormier Realtime gateway.

## What the chart renders

With default values, the chart renders:

- Deployment
- Service (ClusterIP)
- ConfigMap
- ServiceAccount
- PodDisruptionBudget
- HorizontalPodAutoscaler
- NetworkPolicy

It can conditionally render these resources based on values and available cluster API versions:

- IngressRoute (`ingressRoute.enabled=true`)
- ServiceMonitor (`metrics.enabled=true` and `observability.serviceMonitor.enabled=true`)
- PrometheusRule (`metrics.enabled=true` and `observability.prometheusRule.enabled=true`)
- Grafana dashboard ConfigMap (`observability.grafanaDashboard.enabled=true`)
- AlertmanagerConfig (`observability.alertmanagerConfig.enabled=true`)

Security defaults include `runAsUser/runAsGroup/fsGroup=1654`, `allowPrivilegeEscalation=false`, `readOnlyRootFilesystem=true`, `capabilities.drop=["ALL"]`, and `automountServiceAccountToken=false`.

## Validate locally

Validated in this repository with Helm `v3.21.4`:

```sh
helm lint ./helm/realtime-gateway --strict
helm template dev-realtime ./helm/realtime-gateway --namespace dev-realtime --values ./cluster/redis/managed-gateway-values.example.yaml
```

## Install and upgrade

Provide environment-specific values through files and `--set` overrides:

```sh
RELEASE_NAME='<release-name>'
NAMESPACE='<namespace>'
VALUES_FILE='<path-to-values.yaml>'
IMAGE_REPOSITORY='<registry/repository>'
IMAGE_DIGEST='sha256:<64-hex-digest>'

helm upgrade --install "$RELEASE_NAME" ./helm/realtime-gateway \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --values "$VALUES_FILE" \
  --set-string image.repository="$IMAGE_REPOSITORY" \
  --set-string image.digest="$IMAGE_DIGEST" \
  --atomic --wait
```

For an official version, download the public `realtime-gateway-<version>.tgz`
asset from that version's GitHub Release and use its path in place of
`./helm/realtime-gateway`. The release also includes `release-manifest.json`,
which binds the coordinated version and source commit to the published gateway
image evidence. Release assets are public when this repository is public; the
short-lived Actions artifact is retained only as workflow evidence.

```sh
VERSION='<version>'
gh release download "v${VERSION}" --pattern "realtime-gateway-${VERSION}.tgz"
helm upgrade --install "$RELEASE_NAME" "./realtime-gateway-${VERSION}.tgz" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  --values "$VALUES_FILE" \
  --set-string image.repository="$IMAGE_REPOSITORY" \
  --set-string image.digest="$IMAGE_DIGEST" \
  --atomic --wait
```

For managed Redis gateway values, use `cluster/redis/managed-gateway-values.example.yaml` as the baseline. For external Redis, use `cluster/redis/external-values.example.yaml`.

## Naming

Release and namespace names are configuration inputs. Use environment-specific names (for example, `dev-realtime` / `dev-realtime`) and keep those values outside source-controlled templates.

## Topology and Redis mode expectations

- `topology=ha` requires at least 3 replicas and keeps PDB/HPA/topology spread enabled.
- `topology=non-ha` requires a single replica and disables HA controls.
- `redis.mode=managed` uses the managed release endpoint; Sentinel discovery is used only when both `redis.mode=managed` and `topology=ha`.
- `redis.mode=external` requires `redis.externalEndpoint`.

## Secrets and credentials

This chart references existing Secrets and does not create credentials.

Pre-create and pass Secret names/keys for:

- `redis.credentialsSecret` (required)
- `diagnostics.operatorTokenSecret` (required when `diagnostics.enabled=true`)
- `metrics.scrapeTokenSecret` (required when `metrics.authorizationPolicy` is set)
- `observability.otlp.headersSecret` (optional)
- `observability.alertmanagerConfig.webhookSecret` (required when alertmanager routing is enabled)

When `networkPolicy.enabled=true`, OTLP egress must be bounded by namespace selector and/or CIDRs, and explicit ports (`observability.otlp.egressPorts`) must be set.

## Rollback

Roll back to a previous chart revision with:

```sh
helm rollback "$RELEASE_NAME" <revision> --namespace "$NAMESPACE" --wait
```

For full promotion/rollback operating guidance, see `../docs/runbooks/README.md`.

## Post-deploy verification

```sh
kubectl -n "$NAMESPACE" rollout status deployment/"$RELEASE_NAME"
kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/instance="$RELEASE_NAME"
kubectl -n "$NAMESPACE" get networkpolicy
helm status "$RELEASE_NAME" -n "$NAMESPACE"
```
