#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${root}/artifacts"
run_id="${GITHUB_RUN_ID:-local}-${RANDOM}"
network="cormier-observability-${run_id}"
collector="cormier-observability-collector-${run_id}"
backend="cormier-observability-backend-${run_id}"
prometheus="cormier-observability-prometheus-${run_id}"
gateway_pid=""
collector_image="otel/opentelemetry-collector-contrib@sha256:45392d534c1edcc809c2d112394029246bc679d2ae5ea7081414a1fc74f2c621"
prometheus_image="prom/prometheus@sha256:49214755b6153f90a597adcbff0252cc61069f8ab69ce8411285cd4a560e8038"

cleanup() {
  if [[ -n "$gateway_pid" ]]; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  docker rm --force "$prometheus" "$collector" "$backend" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run --detach --name "$backend" --network "$network" --network-alias observability-backend \
  --mount "type=bind,source=${root}/observability/conformance/backend.yaml,target=/etc/otelcol-contrib/config.yaml,readonly" \
  "$collector_image" >/dev/null
docker run --detach --name "$collector" --network "$network" --network-alias observability-collector --publish 127.0.0.1:14318:4318 \
  --mount "type=bind,source=${root}/observability/conformance/collector.yaml,target=/etc/otelcol-contrib/config.yaml,readonly" \
  "$collector_image" >/dev/null
docker run --detach --name "$prometheus" --network "$network" --publish 127.0.0.1:19090:9090 \
  --mount "type=bind,source=${root}/observability/conformance/prometheus.yaml,target=/etc/prometheus/prometheus.yml,readonly" \
  "$prometheus_image" >/dev/null

ASPNETCORE_URLS=http://127.0.0.1:18081 \
Gateway__ShutdownDrainSeconds=1 \
Redis__Endpoint=127.0.0.1:6379 \
Realtime__AllowedOrigins__0=http://127.0.0.1:18081 \
Metrics__OtlpEnabled=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_METRIC_EXPORT_INTERVAL=1000 \
dotnet run --project "$root/src/Cormier.Realtime.Gateway" --configuration Release --no-build --no-launch-profile >"${root}/artifacts/observability-gateway.log" 2>&1 &
gateway_pid=$!

for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:18081/health/live >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --max-time 2 http://127.0.0.1:18081/health/live >/dev/null
curl --fail --silent --max-time 2 http://127.0.0.1:18081/health/ready >/dev/null

query_has_series() {
  local job="$1"
  curl --fail --silent --max-time 2 --get \
    --data-urlencode "query=count(cormier_realtime_health_requests_total{job=\"${job}\"})" \
    http://127.0.0.1:19090/api/v1/query | jq --exit-status '.status == "success" and (.data.result[0].value[1] | tonumber) > 0' >/dev/null
}

query_sum() {
  local job="$1"
  curl --fail --silent --max-time 2 --get \
    --data-urlencode "query=sum(cormier_realtime_health_requests_total{job=\"${job}\"})" \
    http://127.0.0.1:19090/api/v1/query | jq --exit-status -r '.data.result[0].value[1] | tonumber | floor'
}

for _ in $(seq 1 60); do
  if query_has_series collector && query_has_series otlp-backend; then
    break
  fi
  sleep 1
done
query_has_series collector
query_has_series otlp-backend

# A cumulative export after an interruption carries traffic recorded while the collector was absent.
before_interruption="$(query_sum otlp-backend)"
docker stop "$collector" >/dev/null
for _ in $(seq 1 5); do
  curl --fail --silent --max-time 2 http://127.0.0.1:18081/health/live >/dev/null
done
docker start "$collector" >/dev/null
for _ in $(seq 1 60); do
  recovered="$(query_sum otlp-backend 2>/dev/null || echo 0)"
  if (( recovered >= before_interruption + 5 )); then
    break
  fi
  sleep 1
done
recovered="$(query_sum otlp-backend)"
(( recovered >= before_interruption + 5 ))

before_shutdown="$recovered"
curl --fail --silent --max-time 2 http://127.0.0.1:18081/health/live >/dev/null
kill -TERM "$gateway_pid"
wait "$gateway_pid"
gateway_pid=""
for _ in $(seq 1 30); do
  flushed="$(query_sum otlp-backend 2>/dev/null || echo 0)"
  if (( flushed >= before_shutdown + 1 )); then
    break
  fi
  sleep 1
done
flushed="$(query_sum otlp-backend)"
(( flushed >= before_shutdown + 1 ))

echo "OTLP collector, OTLP backend, Prometheus ingestion, interruption recovery, and shutdown flush passed."
