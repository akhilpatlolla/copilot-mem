#!/usr/bin/env bash
# copilot-mem setup: fetch the memory engine at a pinned commit, rename and
# theme it, build it, pull the local model, and wire the hooks into Copilot CLI.
# Safe to re-run; it rebuilds engine/ from scratch every time.
#
#   ./setup.sh                 full setup
#   SKIP_INSTALL=1 ./setup.sh  build only (don't touch ~/.copilot/settings.json);
#                              used by `copilot-mem.mjs setup` for plugin installs
set -euo pipefail
cd "$(dirname "$0")"

ENGINE_REPO=https://github.com/thedotmack/claude-mem
ENGINE_REV=d9b36b66dc68da92af9df238e4c4debab587ba62   # v15.2.1
MODEL=${COPILOT_MEM_OPENAI_COMPAT_MODEL:-qwen2.5-coder:7b}
ENGINE=${COPILOT_MEM_ENGINE_DIR:-engine}   # plugin installs build into ~/.copilot-mem/engine
export COPILOT_MEM_ENGINE_DIR=$ENGINE

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing '$1' — install it from $2" >&2; exit 1; }; }
need git     https://git-scm.com
need node    https://nodejs.org
need bun     https://bun.sh
need ollama  https://ollama.com
need copilot "https://github.com/github/copilot-cli (npm i -g @github/copilot)"
[ "$(uname)" = Darwin ] || echo "! not macOS: the network/file sandbox is macOS-only; settings locks still apply" >&2

echo "→ fetching engine @ ${ENGINE_REV:0:7}"
if [ ! -d "$ENGINE/.git" ]; then
  mkdir -p "$ENGINE"
  git init -q "$ENGINE"
  git -C "$ENGINE" remote add origin "$ENGINE_REPO"
fi
git -C "$ENGINE" fetch -q --depth 1 origin "$ENGINE_REV"
git -C "$ENGINE" checkout -q -f FETCH_HEAD
git -C "$ENGINE" clean -fdq -e node_modules   # drop the previous rename/build

echo "→ installing engine dependencies"
(cd "$ENGINE" && bun install --frozen-lockfile >/dev/null)

echo "→ renaming, theming and building the engine"
LOG=$(mktemp)
node rebrand-engine.mjs >"$LOG" 2>&1 || { tail -30 "$LOG" >&2; echo "✗ engine build failed (full log: $LOG)" >&2; exit 1; }

echo "→ pulling local model $MODEL (writes the memories)"
ollama pull "$MODEL" 2>&1 | tail -1

if [ -z "${SKIP_INSTALL:-}" ]; then
  echo "→ adding hooks to ~/.copilot/settings.json"
  node copilot-mem.mjs install
fi

node copilot-mem.mjs selftest
node copilot-mem.mjs doctor
echo "✓ done — start 'copilot' in any project. Viewer: http://127.0.0.1:37702"
