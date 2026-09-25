#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: pull-ci-image.sh IMAGE}"
attempts="${CI_IMAGE_PULL_ATTEMPTS:-3}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "CI_IMAGE_PULL_ATTEMPTS must be a positive integer." >&2
  exit 2
fi

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if docker pull "$image"; then
    exit 0
  fi

  if ((attempt == attempts)); then
    echo "Unable to pull $image after $attempts attempts." >&2
    exit 1
  fi

  delay=$((attempt * 5))
  echo "Pull attempt $attempt/$attempts failed for $image; retrying in ${delay}s." >&2
  sleep "$delay"
done
