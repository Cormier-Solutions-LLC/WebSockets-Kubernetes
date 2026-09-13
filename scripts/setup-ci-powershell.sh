#!/usr/bin/env bash
set -Eeuo pipefail

: "${CI_POWERSHELL_VERSION:?CI_POWERSHELL_VERSION is required}"
: "${CI_POWERSHELL_LINUX_X64_SHA256:?CI_POWERSHELL_LINUX_X64_SHA256 is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf 'Unsupported runner architecture: %s\n' "$(uname -m)" >&2
  exit 1
fi

install_dir="${RUNNER_TEMP}/powershell-${CI_POWERSHELL_VERSION}"
archive="${RUNNER_TEMP}/powershell-${CI_POWERSHELL_VERSION}-linux-x64.tar.gz"

mkdir -p "$install_dir"
curl --fail --location --retry 3 \
  --output "$archive" \
  "https://github.com/PowerShell/PowerShell/releases/download/v${CI_POWERSHELL_VERSION}/powershell-${CI_POWERSHELL_VERSION}-linux-x64.tar.gz"
printf '%s  %s\n' "$CI_POWERSHELL_LINUX_X64_SHA256" "$archive" | sha256sum --check
tar --extract --gzip --file "$archive" --directory "$install_dir"
chmod +x "$install_dir/pwsh"
printf '%s\n' "$install_dir" >> "$GITHUB_PATH"
# shellcheck disable=SC2016 # PowerShell expands this expression.
"$install_dir/pwsh" -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
