#!/usr/bin/env bash
set -euo pipefail

repository="Cormier-Solutions-LLC/WebSockets-Kubernetes"
environment="package-production"
nuget_user=""
dispatch=false

usage() {
  cat <<'EOF'
Configure the GitHub side of NuGet.org Trusted Publishing.

Usage:
  configure-nuget-trusted-publishing.sh --nuget-user <profile-name> [options]

Options:
  --nuget-user <name>  NuGet.org profile name that owns or created the policy.
  --repository <name>  GitHub OWNER/REPOSITORY (default: Cormier-Solutions-LLC/WebSockets-Kubernetes).
  --environment <name> GitHub environment (default: package-production).
  --dispatch           Dispatch package publication after confirming the NuGet.org policy exists.
  --help               Show this help.

This script does not create or store a permanent NuGet API key. NuGet.org currently
requires its Trusted Publishing policy to be created in the account web interface.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --nuget-user)
      (($# >= 2)) || fail "--nuget-user requires a value."
      nuget_user="$2"
      shift 2
      ;;
    --repository)
      (($# >= 2)) || fail "--repository requires a value."
      repository="$2"
      shift 2
      ;;
    --environment)
      (($# >= 2)) || fail "--environment requires a value."
      environment="$2"
      shift 2
      ;;
    --dispatch)
      dispatch=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$nuget_user" ]] || fail "--nuget-user is required. Use the NuGet.org profile name, not an email address."
[[ "$nuget_user" != -* && "$nuget_user" != *[[:space:]]* ]] || fail "The NuGet.org profile name is invalid."
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--repository must use OWNER/REPOSITORY format."
[[ "$environment" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "The GitHub environment name is invalid."

command -v gh >/dev/null 2>&1 || fail "GitHub CLI (gh) is required."
command -v base64 >/dev/null 2>&1 || fail "base64 is required."
gh auth status --hostname github.com >/dev/null 2>&1 || fail "Authenticate first with: gh auth login"

is_admin="$(gh api "repos/${repository}" --jq '.permissions.admin')"
[[ "$is_admin" == "true" ]] || fail "GitHub admin access to ${repository} is required."

printf '{}' | gh api --method PUT "repos/${repository}/environments/${environment}" --input - >/dev/null
gh variable set NUGET_SOURCE --env "$environment" --repo "$repository" \
  --body "https://api.nuget.org/v3/index.json"
gh variable set NUGET_USER --env "$environment" --repo "$repository" \
  --body "$nuget_user"

workflow="$({
  gh api "repos/${repository}/contents/.github/workflows/packages.yml?ref=main" --jq '.content'
} | tr -d '\n' | base64 --decode)"

for required in \
  "environment: ${environment}" \
  "id-token: write" \
  "uses: NuGet/login@8d196754b4036150537f80ac539e15c2f1028841" \
  'user: ${{ vars.NUGET_USER }}' \
  'NUGET_API_KEY: ${{ steps.nuget_login.outputs.NUGET_API_KEY }}'; do
  grep --fixed-strings --quiet "$required" <<<"$workflow" \
    || fail "The main-branch packages.yml workflow is missing: ${required}"
done

owner="${repository%%/*}"
name="${repository#*/}"
cat <<EOF

GitHub configuration is ready.

Create this policy at https://www.nuget.org/account/trustedpublishing:
  Policy name:      Cormier Realtime GitHub Actions
  Package owner:    the NuGet.org user or organization that will own the packages
  Repository owner: ${owner}
  Repository:       ${name}
  Workflow file:    packages.yml
  Environment:      ${environment}
  Scope:            Push new packages and package versions
  Package glob:     Cormier.Realtime.*

NuGet login user configured in GitHub: ${nuget_user}
No permanent NUGET_API_KEY secret is required.
EOF

if [[ "$dispatch" == "true" ]]; then
  [[ -t 0 ]] || fail "--dispatch requires an interactive terminal so policy creation can be confirmed."
  printf '\nConfirm that the matching NuGet.org policy is active [y/N]: '
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]] || fail "Publication was not dispatched."
  gh workflow run packages.yml --repo "$repository" --ref main \
    --field publish=true \
    --field publish_npm=false \
    --field resume_run_id=""
  printf 'Package publication dispatched. Monitor it with:\n  gh run list --repo %q --workflow packages.yml --limit 1\n' "$repository"
fi
