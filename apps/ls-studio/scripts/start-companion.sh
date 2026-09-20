#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PXDLS_PORT="${PXDLS_PORT:-17880}"
export PXDLS_HOST="${PXDLS_HOST:-127.0.0.1}"
if [[ "${1:-}" == "foreground" ]]; then
  exec node "$ROOT/companion/server.js"
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  exec node "$ROOT/scripts/companion-service.cjs" "$@"
fi
exec node "$ROOT/companion/server.js"
