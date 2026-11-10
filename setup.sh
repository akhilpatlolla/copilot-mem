#!/usr/bin/env bash
# copilot-mem setup: check the requirements, pull the local model that writes
# the memories, wire the hooks into Copilot CLI and run the checks. Safe to re-run.
#
#   ./setup.sh                 full setup
#   SKIP_INSTALL=1 ./setup.sh  leave Copilot's settings.json alone; used by
#                              `copilot-mem.mjs setup` for plugin installs
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing '$1': install it from $2" >&2; exit 1; }; }
need node    https://nodejs.org
need ollama  https://ollama.com
need copilot "https://github.com/github/copilot-cli (npm i -g @github/copilot)"
node -e "new (require('node:sqlite').DatabaseSync)(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(x)')" 2>/dev/null \
  || { echo "✗ Node 22.16+ or 24+ is required (built-in SQLite with full-text search); this is $(node -v)" >&2; exit 1; }
[ "$(uname)" = Darwin ] || echo "! not macOS: the network sandbox is macOS-only" >&2

MODEL=$(node copilot-mem.mjs config COPILOT_MEM_OPENAI_COMPAT_MODEL)   # env, then config.env, then default
echo "→ pulling local model $MODEL (writes the memories)"
ollama pull "$MODEL" 2>&1 | tail -1

if [ -z "${SKIP_INSTALL:-}" ]; then
  echo "→ adding hooks to Copilot's settings.json"
  node copilot-mem.mjs install
fi

node copilot-mem.mjs selftest
node copilot-mem.mjs doctor
echo "✓ done: start 'copilot' in any project. Browse memory: node \"$PWD/copilot-mem.mjs\" viewer"
