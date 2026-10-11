#!/usr/bin/env bash
set -Eeuo pipefail

# The image installs system dependencies for this exact Playwright release.
# Browser revisions are still checked by Playwright on every job.
version="$(npx --no-install playwright --version)"
manifest="${CI_RUNNER_MANIFEST:-/opt/ci-tools/manifest.json}"
if [[ -f "$manifest" ]] && jq --exit-status --arg version "${version#Version }" \
  '.tools.playwright | startswith($version + " ")' "$manifest" >/dev/null; then
  npx --no-install playwright install "$@"
else
  npx --no-install playwright install --with-deps "$@"
fi
