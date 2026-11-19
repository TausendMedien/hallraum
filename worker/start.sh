#!/bin/sh
# Starts the Hallraum transcription worker directly with Python (no Docker).
# The first start sets up a Python environment (one-time download of about 2 GB).
# Stop with Ctrl+C.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

# Find a suitable Python (WhisperX needs 3.10 to 3.13)
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "No suitable Python found (3.10–3.13). Install e.g. with: brew install python@3.12"
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is missing. Install e.g. with: brew install ffmpeg"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "Setting up the Python environment (one time, takes a few minutes) …"
  "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

# Load settings from .env
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
export APP_URL="${WORKER_APP_URL:-${APP_URL:-http://localhost:3000}}"

echo "Hallraum worker connecting to $APP_URL – stop with Ctrl+C"
exec .venv/bin/python worker.py
