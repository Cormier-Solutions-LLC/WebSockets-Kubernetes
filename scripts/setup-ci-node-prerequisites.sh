#!/usr/bin/env bash
set -euo pipefail

if ldconfig -p 2>/dev/null | grep --quiet 'libatomic\.so\.1'; then
  exit 0
fi

sudo apt-get update
sudo apt-get install --yes libatomic1

ldconfig -p | grep --quiet 'libatomic\.so\.1'
