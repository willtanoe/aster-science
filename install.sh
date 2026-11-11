#!/bin/bash
# Installer: create the local instance, patch the upstream daemon, build the
# Dock launcher, and write the (never committed) environment file.
#
# Usage:
#   ./install.sh
#   ./install.sh <base_url> <api_key> [model] [model_map]
#
# model_map is inline JSON or @path/to/map.json.
# Arguments skip the corresponding prompts, so the installer can be scripted.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[install] Node.js 18+ is required (node not found on PATH)." >&2
  exit 1
fi

if [ ! -f config.toml ]; then
  node tools/make-config.mjs
fi

mkdir -p bin claude-science-data/logs

# Patch the newest source/*.dmg. The tool exits 10 when it wrote a new binary
# and 0 when the existing one is already current.
set +e
node tools/patch-aster-science.mjs
PATCH_RC=$?
set -e
if [ "$PATCH_RC" -eq 1 ]; then
  exit 1
fi
if [ ! -x bin/claude-science ]; then
  echo "[install] Put a Claude-Science-<version>.dmg in source/, then run install again." >&2
  exit 1
fi

BASE="${1:-}"
KEY="${2:-}"
MODEL="${3:-}"
MAP="${4:-}"

if [ -z "$BASE" ]; then
  if [ -t 0 ]; then read -r -p "OpenAI-compatible base URL [https://api.openai.com/v1]: " BASE; fi
  BASE="${BASE:-https://api.openai.com/v1}"
fi
if [ -z "$KEY" ] && [ -t 0 ]; then
  read -r -p "API key: " KEY
fi
if [ -z "$KEY" ]; then
  echo "[install] An API key is required." >&2
  exit 1
fi
if [ -z "$MODEL" ]; then
  if [ -t 0 ]; then read -r -p "Upstream model [gpt-4o]: " MODEL; fi
  MODEL="${MODEL:-gpt-4o}"
fi
if [ -z "$MAP" ] && [ -t 0 ]; then
  read -r -p "Model map JSON (optional; leave empty for default aliases): " MAP
fi

ASTER_ENV_BASE="$BASE" ASTER_ENV_KEY="$KEY" ASTER_ENV_MODEL="$MODEL" ASTER_ENV_MAP="$MAP" \
  node tools/write-env.mjs

tools/build-icns.sh
tools/make-app.sh

echo
echo "[install] Wrote env.local.sh (gitignored) and 'Aster Science.app'."
echo "[install] Run: ./aster-science.sh serve     (or double-click Aster Science.app)"
