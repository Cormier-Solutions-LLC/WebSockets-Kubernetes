#!/usr/bin/env bash
set -euo pipefail

if ldconfig -p 2>/dev/null | grep 'libatomic\.so\.1' >/dev/null; then
  exit 0
fi

privilege=()
if (( EUID != 0 )); then
  privilege=(sudo -n)
fi
"${privilege[@]}" apt-get update
"${privilege[@]}" apt-get install --yes libatomic1

ldconfig -p | grep 'libatomic\.so\.1' >/dev/null
