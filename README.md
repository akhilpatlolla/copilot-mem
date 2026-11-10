# copilot-mem

**Persistent memory for GitHub Copilot CLI, stored and written on your machine.**

Copilot forgets everything when a session ends. copilot-mem records what Copilot
does: your prompts, the tools it runs, and the results. A **local** model
(Ollama) turns each finished turn into short, searchable notes and a summary.
The next time you open Copilot in that project, the relevant history is already
in its context, and Copilot can search the rest on demand.

- **No dependencies.** `copilot-mem.mjs` is the whole engine: hooks, storage
  (Node's built-in SQLite), note writer, search, viewer. `setup.sh` installs it
  and `theme/` holds the viewer icon. No daemon, no `npm install`, nothing
  downloaded besides the model.
- **Plugin optional, no MCP server.** Install it as a Copilot CLI plugin, or
  wire the hooks straight into `~/.copilot/settings.json`. The second option
  keeps working where org policy blocks plugins or MCP. Search is a plain shell
  command.
- **Local by enforcement, not just configuration.** The note writer only talks
  to a loopback address, refuses cloud models, and on macOS runs in a sandbox
  that stops it reaching anything else.
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
- [Updating, uninstalling](#updating-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Status and limitations](#status-and-limitations)
- [Repository layout](#repository-layout)
- [License](#license)

---

## How it works

```
 Copilot CLI ──hooks (plugin or settings.json)──▶ copilot-mem.mjs hook <Event>
   │  SessionStart       → inject recent notes          │
   │  UserPromptSubmit   → record the prompt            ├─ SQLite  ~/.copilot-mem/memory.db
   │  PostToolUse(+Fail) → record the tool call         │
   │  Stop               → close the turn ──────────────┴─▶ note writer (background, sandboxed)
   │  SessionEnd         → close anything left open             └─ Ollama 127.0.0.1:11434
   └─ runs `copilot-mem.mjs search …` in its shell
```

1. Copilot fires a hook and sends JSON on stdin. The hook writes the prompt or
   tool call to `~/.copilot-mem/memory.db` and returns within milliseconds; it
   never touches the network.
2. When a turn ends (`Stop`), the hook reads Copilot's reply from the session
   transcript, groups the turn's prompt, tool calls and reply, and starts the
   note writer in the background. A turn that was interrupted is closed under
   its own prompt when the next one arrives; a turn that only looked things up
   in memory is not written again.
3. The note writer sends the turn to the local model, which returns typed notes
   (bugfix / feature / refactor / change / discovery / decision) and a turn
   summary. If the model is busy, offline or misconfigured, the turn waits and
   is written later.
4. At the next session start, copilot-mem gives Copilot the project's recent
   notes and last summary as `additionalContext`, plus the search commands.

A project is the git repository you work in, identified by its `origin` URL, or
by its folder when it has no remote. Other clones and linked worktrees of the
same origin share its memory, and a repository's notes follow it when it gains
a remote. A repository without a remote that is moved keeps its memory: its
notes go to the first repository with that folder name opened after the old
folder is gone. At session start, two repositories with the same folder name
don't mix. `search --project`, the viewer, notes imported from 1.0 and notes
saved with `save --project` go by folder name.

## Features

| | |
|---|---|
| **Automatic capture** | prompts, every tool call and its result (failures included), the reply of each turn |
| **Automatic recall** | each new session starts with the project's recent notes and the last turn summary |
| **On-demand search** | `search`, `timeline`, `get`, `save`: plain shell commands Copilot runs itself (no MCP) |
| **Full-text search** | SQLite FTS5 over notes, summaries and prompts, ranked by relevance |
| **Web viewer** | `copilot-mem.mjs viewer`: browse and search memory per project, GitHub Primer colours (light and dark) |
| **Any Copilot model** | hosted models through your Copilot plan, or fully offline BYOK through Ollama |
| **Self-checks** | `doctor` checks the database, the model and the sandbox; `selftest` runs the built-in tests |

## Requirements

- macOS (the network sandbox uses `sandbox-exec`; see [limitations](#status-and-limitations) for Linux)
- [Node.js](https://nodejs.org) 24+ or 22.16+, whose built-in SQLite includes
  full-text search (`setup.sh` checks this)
- [Ollama](https://ollama.com), running
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) 1.0.103+
- For GitHub-hosted models: a Copilot plan that includes the CLI (Pro, Pro+,
  Business or Enterprise). Offline BYOK mode needs no plan.

## Quick start

There are two ways to install it. Both give the same result; pick one.

### Option A: Copilot CLI plugin

```sh
copilot plugin install akhilpatlolla/copilot-mem
node ~/.copilot/installed-plugins/*/*copilot-mem/copilot-mem.mjs setup   # one time: pulls the model, runs the checks
```

The plugin supplies the hooks, so recording starts with the next session. `setup`
pulls the note-writing model; until it's there, finished turns wait in the
database and are written once the model is available.

### Option B: no plugin (works where plugins are blocked)

```sh
git clone https://github.com/akhilpatlolla/copilot-mem
cd copilot-mem
./setup.sh
```

`setup.sh` does the following:

1. checks the requirements
2. pulls the note-writing model (`qwen2.5-coder:7b` unless you configured another)
3. adds the hooks to `~/.copilot/settings.json`, leaving your other settings and hooks alone
4. runs `selftest` and `doctor`

A healthy `doctor` looks like this:

```
ok   database ~/.copilot-mem/memory.db
ok   model server reachable at http://127.0.0.1:11434/v1
ok   note-writing model qwen2.5-coder:7b available
ok   note-writing model qwen2.5-coder:7b runs on this machine
ok   sandbox blocks the internet
ok   sandbox allows loopback
info hooks in ~/.copilot/settings.json
info 12 notes, 9 summaries, 9 prompts
info turns: 0 waiting for the writer, 0 failed
```

Then use Copilot as usual. Memory is recorded from the first session and shows up
from the second session onwards.

> With option B the hooks store the absolute path of `copilot-mem.mjs`. If you
> move the folder, run `node copilot-mem.mjs install` again. If both options are
> installed, only the `settings.json` hooks record, so nothing is recorded twice.

## Using it

### With GitHub-hosted models

```sh
copilot                        # or: copilot --model <model>
```

Nothing else is needed. The hooks work the same for every model.

### Fully offline (BYOK)

```sh
ollama pull qwen3:8b           # any Ollama model that supports tool calling
COPILOT_OFFLINE=true COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:11434/v1 COPILOT_MODEL=qwen3:8b copilot
```

Small local models are weak agents. Use the largest tool-calling model your
machine runs well. Copilot and the note writer share Ollama, so notes are
written once Copilot is idle.

### Searching memory

Copilot learns these commands from its session-start context and runs them in
its shell. You can run them yourself too:

```sh
node copilot-mem.mjs search "auth token bug"                  # index of matches with IDs
node copilot-mem.mjs search "migration" --project api --type observations --limit 10
node copilot-mem.mjs timeline 123                             # notes around note 123
node copilot-mem.mjs get 123 S45 P67                          # full details of chosen IDs
node copilot-mem.mjs save "we use sqlite for X because Y" --title "db choice"
```

Results list notes as `#123`, turn summaries as `S45` and prompts as `P67`. In
the shell, write note IDs without the `#` (it starts a comment). Search with no
`--project` covers all projects; `--project` takes the repository's folder name.

Memory commands are `node` shell commands, so Copilot asks before it runs one.
Approve it for the session, or start Copilot with
`--allow-tool 'shell(node:*)'` (this allows every `node` command) and
`--add-dir <copilot-mem folder>` (the script lives outside your project).
Copilot's own memory lookups are not recorded as new notes.

### Web viewer

```sh
node copilot-mem.mjs viewer    # prints http://127.0.0.1:37702/?t=<token>; Ctrl+C to stop
```

Open the printed link. Every page needs its token, which changes each time the
viewer starts.

### All commands

| Command | |
|---|---|
| `setup` | pull the model and run the checks (for plugin installs, option A) |
| `install` / `uninstall` | add or remove the hooks in `~/.copilot/settings.json` (data is kept) |
| `doctor` | check the database, the model and the sandbox; show what's stored and queued |
| `selftest` | built-in tests (no network, throwaway database) |
| `viewer` | local web viewer |
| `search` / `timeline` / `get` / `save` | memory search, see above |
| `config <KEY>` | print a setting's effective value |
| `hook <Event>`, `writer` | called by Copilot and by the hooks; not for manual use |

## Configuration

Optional settings go in `~/.copilot-mem/config.env` (created by `install`) or in
the environment. They take effect on the next hook; nothing needs restarting.

| Setting | Default | |
|---|---|---|
| `COPILOT_MEM_OPENAI_COMPAT_MODEL` | `qwen2.5-coder:7b` | model that writes the notes; cloud models (`…-cloud`) are refused |
| `COPILOT_MEM_OPENAI_COMPAT_BASE_URL` | `http://127.0.0.1:11434/v1` | any OpenAI-compatible server; must be a loopback address, anything else is refused |
| `COPILOT_MEM_VIEWER_PORT` | `37702` | web viewer port |
| `COPILOT_MEM_CONTEXT_OBSERVATIONS` | `50` | notes included at session start |
| `COPILOT_MEM_SKIP_TOOLS` | `report_intent,task_complete,think,…` | tools not worth recording |
| `COPILOT_MEM_LOG_LEVEL` | `INFO` | `DEBUG` also logs hook input and the model's replies to `~/.copilot-mem/logs/copilot-mem.log` |

`COPILOT_MEM_DATA_DIR` (default `~/.copilot-mem`) moves the database, config and
logs. It can only be set in the environment Copilot starts from, not in
`config.env`, which lives in that folder.

## Privacy model

Settings can be changed by mistake, so the important guarantees are checked by
the code and, on macOS, enforced by the operating system.

- **Hooks don't use the network.** They only write to the local database and
  read Copilot's own session transcript.
- **The note writer only talks to loopback.** A model URL that isn't a loopback
  address is refused, redirects are refused, proxies are bypassed, and on macOS
  the writer runs in a sandbox (seatbelt) that denies all outbound network
  except loopback, DNS included.
- **The model must run on this machine.** Ollama can also serve "cloud" models
  from ollama.com through the same local address; the writer refuses those by
  name and by what Ollama reports for them. For a hard guarantee, run Ollama with
  `OLLAMA_NO_CLOUD=1`, and don't point the URL at a local proxy to a remote API.
- **Your data stays private.** The database, logs and `config.env` are readable
  only by you, and so is the default `~/.copilot-mem` folder.
- **Memory follows the repository.** Any checkout whose git config names the
  same `origin` gets that repository's notes at session start. Don't use Copilot
  with copilot-mem in an untrusted copy (say, an unpacked archive with its own
  `.git`) that claims the origin of one of your private repositories.
- **The viewer** runs in the same sandbox, listens on `127.0.0.1` only, answers
  only requests that carry the token from its printed link, rejects requests for
  any other host name (no DNS rebinding), and its pages carry a
  Content-Security-Policy that blocks scripts and every outside request.
- **No telemetry, no accounts, no cloud features.** There is nothing to switch off.

**Verify it yourself:**

```sh
node copilot-mem.mjs doctor    # model, sandbox and loopback checks
```

**What does leave the machine:** in **hosted** mode, Copilot sends its context
to GitHub's model, as it always does. That context includes the memory
copilot-mem injects. Storage, note-writing and search stay local. In **BYOK**
mode with `COPILOT_OFFLINE=true`, nothing leaves the machine.

## Updating, uninstalling

Option A (plugin):

```sh
copilot plugin update copilot-mem
copilot plugin uninstall copilot-mem   # data stays in ~/.copilot-mem
```

Option B (no plugin):

```sh
git pull                               # nothing to rebuild
node copilot-mem.mjs uninstall         # remove the hooks (data stays in ~/.copilot-mem)
```

Upgrading from 1.0 to 2.0:

1. Stop the 1.0 background worker before updating (`node copilot-mem.mjs stop`
   with 1.0 still in place), or end it afterwards with
   `lsof -ti tcp:37702 -sTCP:LISTEN | xargs kill`. It holds port 37702, which the
   2.0 viewer uses.
2. Update as above, then delete the 1.0 `engine/` folder (in the clone, or
   `~/.copilot-mem/engine` for plugin installs).
3. The notes and summaries in `~/.copilot-mem/copilot-mem.db` are imported into
   the new `memory.db` once, automatically, and matched to projects by folder
   name. The other 1.0 files in that folder can be deleted afterwards.

To delete all memory, remove `~/.copilot-mem`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor`: model server not reachable | start Ollama (`ollama serve` or the app) |
| `doctor`: model missing | `ollama pull qwen2.5-coder:7b` (or your configured model) |
| `doctor`: database fails | Node lacks SQLite with full-text search; use Node 24+ or 22.16+ |
| Copilot: "No supported model available" / "model is not supported" | your plan doesn't include Copilot CLI; upgrade, or use BYOK |
| Nothing recorded | check that the hooks are installed (`doctor` shows where), and look at `~/.copilot-mem/logs/` |
| `install`: can't read settings.json as plain JSON | the file has comments; remove them, or add the hooks by hand |
| Notes appear late | the writer waits for the model; with BYOK it shares Ollama with Copilot. `doctor` shows the queue |
| See what the hooks receive | set `COPILOT_MEM_LOG_LEVEL=DEBUG` and read `~/.copilot-mem/logs/copilot-mem.log` |

## Status and limitations

Tested on macOS with Copilot CLI 1.0.103 and Ollama 0.40, Copilot running
offline on `qwen3:8b`, notes written by `qwen2.5-coder:7b`:

- capture of prompts, tool calls (failures included) and replies in real Copilot sessions
- notes and summaries written in the background, inside the sandbox
- memory injected at session start and used by the model to answer
- Copilot finding the search command in its context and running it
- sandbox network blocks; viewer (loopback only, token link, host check, CSP)

Note quality follows the note-writing model: a 7B model gets the facts right but
also writes some low-value notes. A larger local model writes better ones.

Limitations:

- macOS only for the sandbox. On Linux the loopback, redirect and cloud-model
  checks still apply, but use a network namespace or firewall rule for the same
  guarantee.
- Search is keyword-based (FTS5), not semantic.
- Not included: MCP tools, team or cloud features, importing other tools' history.

## Repository layout

```
copilot-mem.mjs      the engine: hooks, storage, note writer, search, viewer,
                     install/doctor/selftest
setup.sh             one-command setup (requirements, model, hooks, checks)
plugin.json          Copilot CLI plugin manifest (Agent Plugins v1.0.0)
com.github.copilot/hooks/hooks.json   plugin hooks (option A)
theme/               Copilot octicon (MIT) + its license, used by the viewer
~/.copilot-mem/      your data: memory.db, config.env, logs
```

## License

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

- Copilot icon: [Primer Octicons](https://github.com/primer/octicons) (MIT)
- Colours: [Primer](https://primer.style) design tokens

GitHub and GitHub Copilot are trademarks of GitHub, Inc. This project is not
affiliated with or endorsed by GitHub.
