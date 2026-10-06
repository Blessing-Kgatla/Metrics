#!/usr/bin/env bash
# Starts the RepoLens dev server (default port 8000).
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -m uvicorn backend.main:app --host 127.0.0.1 --port "${PORT:-8000}" "$@"
