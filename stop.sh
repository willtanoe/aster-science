#!/bin/bash
# Stop the daemon and the translation proxy started by aster-science.sh.
set -uo pipefail
cd "$(dirname "$0")"

if [ -x bin/claude-science ] && [ -f config.toml ]; then
  bin/claude-science stop --config "$PWD/config.toml" --here || true
fi

PID_FILE="$PWD/claude-science-data/aster-proxy.pid"
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Fallback for a proxy started without a pid file (older run, manual start).
if pgrep -f "$PWD/proxy/aster-proxy.mjs" >/dev/null 2>&1; then
  pkill -f "$PWD/proxy/aster-proxy.mjs" || true
fi
