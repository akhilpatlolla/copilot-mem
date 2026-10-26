# copilot-mem

**Persistent memory for GitHub Copilot CLI, running entirely on your machine.**

Copilot forgets everything when a session ends. copilot-mem records what Copilot
does: your prompts, the tools it runs, and the results. A **local** Ollama model
compresses that into short, searchable notes and turn summaries. The next time
you open Copilot in that project, the relevant history is already in its context,
and Copilot can search the rest on demand.

- **No plugin and no MCP server.** It uses Copilot's own hooks plus a shell
  command, so it keeps working where org policy blocks plugins or MCP.
- **Local by enforcement, not just configuration.** A macOS sandbox stops the
  memory system reaching the internet or reading other tools' data.
- **Works with any Copilot model.** GitHub-hosted models on a paid plan, or fully
  offline with a local model (BYOK).

---

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using it](#using-it)
- [Configuration](#configuration)
- [Privacy model](#privacy-model)
- [Running next to claude-mem](#running-next-to-claude-mem)
- [Updating, uninstalling](#updating-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Status and limitations](#status-and-limitations)
- [Repository layout](#repository-layout)
- [Credits and license](#credits-and-license)

---

## How it works

```
 Copilot CLI ──hooks (~/.copilot/settings.json)──▶ copilot-mem.mjs ──▶ memory worker (127.0.0.1:37702)
   │  SessionStart       → inject recent memory           │  (sandboxed)          │
   │  UserPromptSubmit   → record prompt                  │                       ├─ SQLite  ~/.copilot-mem/copilot-mem.db
   │  PostToolUse(+Fail) → record tool call + result      │                       ├─ Chroma  ~/.copilot-mem/chroma (vectors)
   │  Stop               → summarize the turn             │                       └─ Ollama  127.0.0.1:11434 (writes notes)
   │  SubagentStop / SessionEnd → close out               │
   └─ runs `copilot-mem.mjs search …` in its shell ───────┘   web viewer: http://127.0.0.1:37702
```

1. Copilot fires a hook. Copilot CLI accepts Claude-style hook configs and sends
   Claude-shaped JSON on stdin.
2. `copilot-mem.mjs` adapts the payload for Copilot. For example, it reads the
   assistant's reply out of Copilot's `events.jsonl` transcript. It then hands
   the payload to the memory engine inside a macOS sandbox.
3. The engine queues the event. The local model turns it into a typed note
   (bugfix / feature / decision / discovery / change) or a turn summary.
4. At the next session start, the engine builds a compact timeline for the
   current project. copilot-mem returns it as `additionalContext`, the field
   Copilot reads, and adds instructions for the search commands.

The memory engine is [claude-mem](https://github.com/thedotmack/claude-mem)
(Apache-2.0). `setup.sh` downloads it at a pinned commit and
`rebrand-engine.mjs` renames it to copilot-mem and gives its viewer the GitHub
look.

## Features

| | |
|---|---|
| **Automatic capture** | prompts, every tool call and its result (failures included), a summary per turn, subagent results |
| **Automatic recall** | each new session starts with recent notes, the last summary and open work for the project |
| **On-demand search** | `search`, `timeline`, `get`, `save`: plain shell commands Copilot runs itself (no MCP) |
| **Semantic search** | local Chroma vector index with an on-disk embedding model |
| **Web viewer** | timeline, sessions, prompts and a "My Work" page at <http://127.0.0.1:37702>, in GitHub Primer colours (light and dark) with the Copilot icon |
| **Any Copilot model** | hosted (GPT, Claude, Gemini… via your Copilot plan) or offline BYOK through Ollama |
| **Isolated** | own port, data folder and database; runs side by side with claude-mem |
| **Self-checks** | `doctor` checks Ollama, the sandbox and the worker; `selftest` runs the built-in tests |

## Requirements

- macOS (the sandbox uses `sandbox-exec`; see [limitations](#status-and-limitations) for Linux)
- [Node.js](https://nodejs.org) 20+, [Bun](https://bun.sh) 1.2.16+, git
- [Ollama](https://ollama.com), running
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) 1.0.103+
- For GitHub-hosted models: a Copilot plan that includes the CLI (Pro, Pro+,
  Business or Enterprise). Copilot Free is refused by the CLI. Offline BYOK mode
  needs no plan.

## Quick start

```sh
git clone https://github.com/akhilpatlolla/copilot-mem
cd copilot-mem
./setup.sh
```

`setup.sh` does the following:

1. checks the requirements
2. fetches the engine at the pinned commit
3. installs its dependencies
4. renames, themes and builds it
5. pulls `qwen2.5-coder:7b`
6. adds the hooks to `~/.copilot/settings.json`, leaving your other settings alone
7. runs `selftest` and `doctor`

A healthy `doctor` looks like this:

```
ok   engine at …/copilot-mem/engine/plugin
ok   ollama reachable at http://127.0.0.1:11434/v1
ok   observer model qwen2.5-coder:7b pulled
ok   sandbox blocks internet
ok   sandbox allows loopback
ok   sandbox blocks other agents' data (~/.claude)
ok   worker on 127.0.0.1:37702 (starts on first Copilot session)
```

Then use Copilot as usual. Memory is recorded from the first session and shows up
from the second session onwards.

> The hooks store the absolute path of `copilot-mem.mjs`. If you move the folder,
> run `node copilot-mem.mjs install` again.

## Using it

### With GitHub-hosted models

```sh
copilot                        # or: copilot --model <model>
```

Nothing else is needed. The hooks work the same for every model.

### Fully offline (BYOK)

```sh
ollama pull qwen3:8b           # any Ollama model that supports tool calling
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1 COPILOT_MODEL=qwen3:8b copilot
```

Small local models are weak agents. Use the largest tool-calling model your
machine runs well.

### Searching memory

Copilot learns these commands from its session-start context and runs them in
its shell. You can run them yourself too:

```sh
node copilot-mem.mjs search "auth token bug"                  # index of matches with IDs
node copilot-mem.mjs search "migration" --project api --type observations --limit 10
node copilot-mem.mjs timeline 123                             # what happened around #123
node copilot-mem.mjs get 123 98                               # full details of chosen IDs
node copilot-mem.mjs save "we use sqlite for X because Y" --title "db choice"
```

Search with no `--project` covers all projects.

### Web viewer

<http://127.0.0.1:37702> opens **My Work**. The full memory timeline is at
<http://127.0.0.1:37702/viewer>.

### All commands

| Command | |
|---|---|
| `install` / `uninstall` | add or remove the hooks in `~/.copilot/settings.json` (data is kept) |
| `doctor` | check Ollama, model, sandbox and worker |
| `selftest` | built-in tests |
| `start` / `stop` / `restart` / `status` | control the worker (it also starts by itself on the first Copilot session) |
| `search` / `timeline` / `get` / `save` | memory search, see above |
| `hook <Event>` | called by Copilot; not for manual use |

## Configuration

Optional settings go in `~/.copilot-mem/config.env`. Run
`node copilot-mem.mjs restart` after changing it.

| Setting | Default | |
|---|---|---|
| `COPILOT_MEM_OPENAI_COMPAT_MODEL` | `qwen2.5-coder:7b` | Ollama model that writes the notes |
| `COPILOT_MEM_OPENAI_COMPAT_BASE_URL` | `http://127.0.0.1:11434/v1` | must be a loopback address; anything else is rejected |
| `COPILOT_MEM_WORKER_PORT` | `37702` | worker and viewer port |
| `COPILOT_MEM_CHROMA_ENABLED` | `true` | semantic (vector) search |
| `COPILOT_MEM_CONTEXT_OBSERVATIONS` | `50` | notes included at session start |
| `COPILOT_MEM_SKIP_TOOLS` | `report_intent,task_complete,think,…` | tools not worth recording |
| `COPILOT_MEM_LOG_LEVEL` | `INFO` | `DEBUG` also logs hook input/output to `~/.copilot-mem/logs/copilot-mem.log` |

Any other engine setting (`COPILOT_MEM_*`) can be set here too, except the
locked ones below.

## Privacy model

Settings can be changed by mistake, so the important guarantees are enforced by
the operating system.

**Sandbox (macOS seatbelt).** Every copilot-mem process (hooks, worker, vector
database) runs under a profile that:

- denies **all outbound network except loopback**, DNS included
- denies reading or writing **other agents' data**: `~/.claude`, `~/.claude-mem`,
  `~/.codex`, `~/.gemini`, `~/.cursor`, `~/.local/share/opencode`. The engine
  has an importer that would otherwise read those folders.

**Browser.** The viewer pages carry a Content-Security-Policy that only allows
requests to the local worker.

**Locked settings.** These are set through the environment on every launch and
can't be overridden by config files:

- the note-writing model is local Ollama; hosted-provider fallback is off
- telemetry is off (`DO_NOT_TRACK`, a declined consent file, and the telemetry
  host pointed at a dead local port)
- cloud sync, TeamBrain, Telegram alerts, transcript watchers and scheduled agent
  runs are off
- Python packages resolve offline (`UV_OFFLINE`), and cloud API keys are removed
  from the engine's environment

**Verify it yourself:**

```sh
node copilot-mem.mjs doctor                               # sandbox checks
lsof -nP -a -p "$(pgrep -f copilot-mem/engine/plugin/scripts/worker-service)" -i   # only 127.0.0.1
```

**What does leave the machine:** in **hosted** mode, Copilot sends its context
to GitHub's model, as it always does. That context includes the memory
copilot-mem injects. Memory storage, note-writing and search stay local. In
**BYOK** mode nothing leaves the machine.

## Running next to claude-mem

copilot-mem has its own port (37702 versus 37701), data folder
(`~/.copilot-mem`), database and settings. The sandbox stops it reading
`~/.claude` or `~/.claude-mem`. The two run side by side without touching each
other.

## Updating, uninstalling

```sh
git pull && ./setup.sh                 # update copilot-mem; re-fetches and rebuilds the engine
node copilot-mem.mjs uninstall         # remove the hooks (data stays in ~/.copilot-mem)
node copilot-mem.mjs stop
```

To move to a newer engine release, change `ENGINE_REV` in `setup.sh` and run it.
`rebrand-engine.mjs` stops with an error if an upstream change moved code it
patches, so nothing is skipped silently.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor`: ollama not reachable | start Ollama (`ollama serve` or the app) |
| `doctor`: model not pulled | `ollama pull qwen2.5-coder:7b` (or your configured model) |
| Copilot: "No supported model available" / "model is not supported" | your plan doesn't include Copilot CLI (Copilot Free); upgrade, or use BYOK |
| Nothing recorded | check that `~/.copilot/settings.json` has the hooks (`node copilot-mem.mjs install`), and look at `~/.copilot-mem/logs/` |
| Notes appear late in BYOK mode | Copilot and the note-writer share Ollama; notes are written once Copilot is idle |
| See what the hooks send and receive | set `COPILOT_MEM_LOG_LEVEL=DEBUG`, restart, and read `~/.copilot-mem/logs/copilot-mem.log` |

## Status and limitations

Tested on macOS with Copilot CLI 1.0.103 and Ollama 0.40:

- ✅ capture of prompts, tool calls and turn summaries in real Copilot sessions
- ✅ memory injected at session start and used by the model
- ✅ search commands; sandbox network and file blocks; viewer theme in dark mode
- ⚠️ not yet tested: Copilot discovering and running the search command on its own; GitHub-hosted models (the test account was on Copilot Free); viewer light mode
- macOS only for the sandbox. On Linux the locked settings still apply, but use a
  network namespace or firewall rule for the same guarantee.
- Not included: MCP tools, knowledge corpora, team or cloud features, and
  importing other agents' history.

## Repository layout

```
copilot-mem.mjs      the whole Copilot integration: hooks, settings locks, sandbox,
                     search CLI, install/doctor/selftest
setup.sh             one-command setup (fetch, build, model, hooks, checks)
rebrand-engine.mjs   renames the engine to copilot-mem, applies theme/, rebuilds
theme/               GitHub Primer colours, Copilot octicon (MIT) + its license
engine/              (generated by setup.sh; not committed)
~/.copilot-mem/      your data: database, vectors, logs, config.env
```

## Credits and license

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

- Memory engine: [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman (Apache-2.0)
- Copilot icon: [Primer Octicons](https://github.com/primer/octicons) (MIT)
- Colours: [Primer](https://primer.style) design tokens

GitHub and GitHub Copilot are trademarks of GitHub, Inc. This project is not
affiliated with or endorsed by GitHub.
