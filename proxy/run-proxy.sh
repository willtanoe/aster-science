#!/bin/bash
# Run the translation proxy in the foreground (the launcher starts this in the
# background and logs to claude-science-data/logs/aster-proxy.log).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f env.local.sh ]; then
  # shellcheck disable=SC1091
  . ./env.local.sh
fi
exec node "$PWD/proxy/aster-proxy.mjs"
