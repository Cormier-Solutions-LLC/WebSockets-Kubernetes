#!/usr/bin/env bash
set -euo pipefail

: "${CI_REDIS_IMAGE:?CI_REDIS_IMAGE must contain the complete Redis image reference}"

container_name="cormier-ci-redis-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}"
bind_address="${CI_REDIS_BIND_ADDRESS:-127.0.0.1}"
host_port="${CI_REDIS_PORT:-6379}"
docker run --detach --rm \
  --name "$container_name" \
  --publish "${bind_address}:${host_port}:6379" \
  --health-cmd "redis-cli ping" \
  --health-interval 2s \
  --health-timeout 2s \
  --health-retries 15 \
  "$CI_REDIS_IMAGE" >/dev/null

for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$container_name")
  if [[ "$status" == "healthy" ]]; then
    exit 0
  fi
  if [[ "$status" == "unhealthy" ]]; then
    docker logs "$container_name"
    exit 1
  fi
  sleep 1
done

docker logs "$container_name"
exit 1
