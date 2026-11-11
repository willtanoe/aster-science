#!/bin/bash
# aster-science — self-contained Claude Science instance + Anthropic→OpenAI proxy.
#
# Usage: ./aster-science.sh <command> [flags]   (serve, status, url, stop, logs, …)
#
# The launcher always runs from its own directory, sources env.local.sh, makes
# sure the proxy is answering, then hands the command to the patched daemon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
DATA="$ROOT/claude-science-data"

if [ -f env.local.sh ]; then
  # shellcheck disable=SC1091
  . ./env.local.sh
fi

: "${ASTER_PROXY_PORT:=8787}"
: "${ASTER_PROXY_HOST:=127.0.0.1}"
PROXY_URL="http://${ASTER_PROXY_HOST}:${ASTER_PROXY_PORT}"

if [ ! -f config.toml ]; then
  node tools/make-config.mjs
fi

mkdir -p "$DATA/logs"

if ! curl -fsS --max-time 1 "$PROXY_URL/health" >/dev/null 2>&1; then
  nohup node "$ROOT/proxy/aster-proxy.mjs" >>"$DATA/logs/aster-proxy.log" 2>&1 &
  echo $! >"$DATA/aster-proxy.pid"
  for _ in $(seq 1 40); do
    curl -fsS --max-time 1 "$PROXY_URL/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
  if ! curl -fsS --max-time 1 "$PROXY_URL/health" >/dev/null 2>&1; then
    echo "[aster-science] WARNING: proxy not answering on $PROXY_URL" >&2
    echo "[aster-science] see claude-science-data/logs/aster-proxy.log" >&2
  fi
fi

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_API_KEY="sk-ant-aster"

# The daemon unpacks an unbranded web-dist on the first run of a version.
# The rebrand tool exits immediately when the tree is already branded and
# waits for extraction otherwise. It is version-agnostic.
if [ "${1:-}" = "serve" ]; then
  nohup node "$ROOT/tools/rebrand-web-dist.mjs" --watch --timeout 180 --quiet \
    >>"$DATA/logs/rebrand.log" 2>&1 &
fi

# The package-install sandbox only re-allows reads under the data dirs; a
# daemon whose cwd is the repo root makes micromamba's getcwd() fail with
# EPERM. Run it from / and pin the instance with --data-dir instead of --here.
cd /
if [ "${1:-}" = "serve" ]; then
  exec "$ROOT/bin/claude-science" "$@" --config "$ROOT/config.toml" --data-dir "$DATA" --no-auto-update
fi
exec "$ROOT/bin/claude-science" "$@" --config "$ROOT/config.toml" --data-dir "$DATA"
