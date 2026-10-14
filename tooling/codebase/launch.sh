#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export CBM_ALLOWED_ROOT="$ROOT"
export CBM_CACHE_DIR="$ROOT/.codex-design/cache"
cd "$ROOT"
exec "$ROOT/.codex-design/bin/codebase-memory-mcp" "$@"
