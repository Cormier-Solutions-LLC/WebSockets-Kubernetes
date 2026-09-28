#!/usr/bin/env bash
set -Eeuo pipefail

: "${CI_GH_VERSION:?CI_GH_VERSION is required}"
: "${CI_GH_LINUX_AMD64_SHA256:?CI_GH_LINUX_AMD64_SHA256 is required}"
: "${CI_GH_DOWNLOAD_BASE_URL:?CI_GH_DOWNLOAD_BASE_URL is required}"
: "${CI_HELM_VERSION:?CI_HELM_VERSION is required}"
: "${CI_HELM_LINUX_AMD64_SHA256:?CI_HELM_LINUX_AMD64_SHA256 is required}"
: "${CI_HELM_DOWNLOAD_BASE_URL:?CI_HELM_DOWNLOAD_BASE_URL is required}"
: "${CI_KUBECTL_VERSION:?CI_KUBECTL_VERSION is required}"
: "${CI_KUBECTL_LINUX_AMD64_SHA256:?CI_KUBECTL_LINUX_AMD64_SHA256 is required}"
: "${CI_KUBECTL_DOWNLOAD_BASE_URL:?CI_KUBECTL_DOWNLOAD_BASE_URL is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'Unsupported runner architecture: %s\n' "$(uname -m)" >&2
  exit 1
fi

tools_dir="${RUNNER_TEMP}/deployment-tools"
gh_archive="${RUNNER_TEMP}/gh_${CI_GH_VERSION}_linux_amd64.tar.gz"
helm_archive="${RUNNER_TEMP}/helm-v${CI_HELM_VERSION}-linux-amd64.tar.gz"
kubectl_binary="${RUNNER_TEMP}/kubectl-v${CI_KUBECTL_VERSION}-linux-amd64"

mkdir -p "$tools_dir"

curl --fail --location --retry 3 \
  --output "$gh_archive" \
  "${CI_GH_DOWNLOAD_BASE_URL%/}/v${CI_GH_VERSION}/gh_${CI_GH_VERSION}_linux_amd64.tar.gz"
printf '%s  %s\n' "$CI_GH_LINUX_AMD64_SHA256" "$gh_archive" | sha256sum --check
tar --extract --gzip --file "$gh_archive" --directory "$tools_dir" \
  --strip-components=2 "gh_${CI_GH_VERSION}_linux_amd64/bin/gh"

curl --fail --location --retry 3 \
  --output "$helm_archive" \
  "${CI_HELM_DOWNLOAD_BASE_URL%/}/helm-v${CI_HELM_VERSION}-linux-amd64.tar.gz"
printf '%s  %s\n' "$CI_HELM_LINUX_AMD64_SHA256" "$helm_archive" | sha256sum --check
tar --extract --gzip --file "$helm_archive" --directory "$tools_dir" \
  --strip-components=1 linux-amd64/helm

curl --fail --location --retry 3 \
  --output "$kubectl_binary" \
  "${CI_KUBECTL_DOWNLOAD_BASE_URL%/}/v${CI_KUBECTL_VERSION}/bin/linux/amd64/kubectl"
printf '%s  %s\n' "$CI_KUBECTL_LINUX_AMD64_SHA256" "$kubectl_binary" | sha256sum --check
install -m 0755 "$kubectl_binary" "$tools_dir/kubectl"

printf '%s\n' "$tools_dir" >> "$GITHUB_PATH"
"$tools_dir/gh" --version
"$tools_dir/helm" version --short
"$tools_dir/kubectl" version --client=true
