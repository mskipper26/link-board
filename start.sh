#!/usr/bin/env bash
set -e

# Load environment variables from the .env sitting next to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

# Prepend the Python interpreter's bin dir to PATH so `uvicorn` resolves.
if [ -n "$PYTHON_BIN_PATH" ]; then
  export PATH="$PYTHON_BIN_PATH:$PATH"
fi

cd "${LINK_BOARD_DIR:-$SCRIPT_DIR}"
exec uvicorn main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8186}"
