#!/usr/bin/env node
// copilot-mem: persistent memory for GitHub Copilot CLI, stored and written on this machine.
//
// Copilot runs this from its hooks (plugin hooks.json or ~/.copilot/settings.json):
//   1. Hooks write prompts and tool calls straight into a local SQLite file
//      (no network, no daemon, back in milliseconds).
//   2. When a turn ends, a short-lived background writer has a local model
//      (Ollama or any OpenAI-compatible server on loopback) turn it into notes
//      and a summary. On macOS it runs in a sandbox that only allows loopback.
//   3. SessionStart hands Copilot the project's recent notes; `search`,
//      `timeline`, `get` and `save` are plain shell commands it can run.
// Needs Node 22.16+ or 24+ (built-in SQLite with full-text search) and a local model server.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
// Always absolute ("~/..." and relative values count from home), and handed on, so the
// background writer, which runs from another folder, opens the same database.
const DATA = resolve(homedir(), (process.env.COPILOT_MEM_DATA_DIR || '.copilot-mem').replace(/^~(?=$|[\\/])/, homedir()));
process.env.COPILOT_MEM_DATA_DIR = DATA;
const DB_FILE = join(DATA, 'memory.db');
const COPILOT_SETTINGS = join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'settings.json');

// ---- config -----------------------------------------------------------------

// Lowest to highest precedence: these defaults, ~/.copilot-mem/config.env, the environment.
const DEFAULTS = {
  COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
  COPILOT_MEM_OPENAI_COMPAT_MODEL: 'qwen2.5-coder:7b',
  COPILOT_MEM_VIEWER_PORT: '37702',
  COPILOT_MEM_CONTEXT_OBSERVATIONS: '50',
  COPILOT_MEM_SKIP_TOOLS: 'report_intent,task_complete,think,update_todo,ask_user,list_bash,stop_bash',
  COPILOT_MEM_LOG_LEVEL: 'INFO',
};

const CONFIG_TEMPLATE = `# copilot-mem settings (all optional; uncomment to change)
# COPILOT_MEM_OPENAI_COMPAT_MODEL=qwen2.5-coder:7b               # local model that writes the notes
# COPILOT_MEM_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1   # must be a loopback address
# COPILOT_MEM_VIEWER_PORT=37702                                  # web viewer port
# COPILOT_MEM_CONTEXT_OBSERVATIONS=50                            # notes shown at session start
# COPILOT_MEM_LOG_LEVEL=INFO                                     # DEBUG also logs hook input
`;

function readConfig() {
  const cfg = { ...DEFAULTS };
  try {
    for (const line of readFileSync(join(DATA, 'config.env'), 'utf8').split('\n')) {
      const m = /^\s*(COPILOT_MEM_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) cfg[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    }
  } catch {}
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('COPILOT_MEM_')) cfg[k] = v;
  return cfg;
}

const unavailable = (msg) => Object.assign(new Error(msg), { unavailable: true });

// The note-writing model must be local: anything but a loopback http(s) address is refused. A
// bad value is a config problem, not the turn's: queued turns wait until it is fixed. The value
// is never echoed (errors reach the session context) and credentials or a query are dropped.
function modelBase(cfg) {
  const raw = String(cfg.COPILOT_MEM_OPENAI_COMPAT_BASE_URL ?? '').trim();
  const u = URL.canParse(raw) ? new URL(raw) : null;
  if (!u || !/^https?:$/.test(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw unavailable(`COPILOT_MEM_OPENAI_COMPAT_BASE_URL must be a loopback address such as http://127.0.0.1:11434/v1 (got ${u ? `host "${u.hostname}"` : 'something that is not a URL'})`);
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

// ---- sandbox ----------------------------------------------------------------

// Seatbelt profile for the processes that talk to the network (note writer,
// viewer): all outbound network is denied except loopback, DNS included, so they
// can't reach past this machine even if a setting is wrong. (A local server that forwards
// elsewhere is another matter: cloudModel refuses Ollama cloud models, but a local proxy to a
// remote API can't be detected.)
const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`;

function sandboxed(cmd, args) {
  if (process.platform !== 'darwin') return [cmd, args]; // macOS only; on Linux use a network namespace or firewall rule
  return ['/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, cmd, ...args]];
}

// ---- database -----------------------------------------------------------------

const SCHEMA = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS prompts (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
-- raw tool calls; turn_id is set when the turn they belong to ends (0: nothing to write)
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT NOT NULL, data TEXT NOT NULL, turn_id INTEGER, created_at TEXT NOT NULL);
-- finished turns, waiting for (or done by) the note writer
CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT NOT NULL, root TEXT, cwd TEXT, prompt TEXT NOT NULL, reply TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT NOT NULL, root TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
  narrative TEXT NOT NULL, facts TEXT NOT NULL, files_read TEXT NOT NULL, files_modified TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY, session_id TEXT, project TEXT NOT NULL, root TEXT, request TEXT NOT NULL, completed TEXT NOT NULL,
  learned TEXT NOT NULL, next_steps TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(kind UNINDEXED, ref UNINDEXED, project UNINDEXED, body);
CREATE INDEX IF NOT EXISTS events_open ON events (session_id, turn_id);
CREATE INDEX IF NOT EXISTS turns_status ON turns (status);`;

async function openDb(file = DB_FILE) {
  process.removeAllListeners('warning'); // Node 22 prints an "experimental" note for SQLite; keep hook stderr clean
  const { DatabaseSync } = await import('node:sqlite');
  // Prompts and tool output can hold secrets: the database is private (its -wal/-shm files
  // follow its mode). The default folder is tightened too (1.0 left it 0755); a folder you
  // chose with COPILOT_MEM_DATA_DIR keeps its own mode.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (dirname(file) === join(homedir(), '.copilot-mem')) try { chmodSync(dirname(file), 0o700); } catch {}
  writeFileSync(file, '', { flag: 'a', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  upgrade(db, DatabaseSync, dirname(file));
  return db;
}

// Schema changes since the first version, and a one-time import of the notes and summaries
// kept by the 1.0 release (copilot-mem.db in the same folder).
function upgrade(db, DatabaseSync, dir) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version; // another hook may have upgraded meanwhile
    if (version < 1) {
      for (const t of ['turns', 'observations', 'summaries']) {
        if (!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = 'root'`).get()) db.exec(`ALTER TABLE ${t} ADD COLUMN root TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS observations_project ON observations (project, id);
        CREATE INDEX IF NOT EXISTS observations_root ON observations (root, id);
        CREATE INDEX IF NOT EXISTS summaries_project ON summaries (project, id);
        CREATE INDEX IF NOT EXISTS summaries_root ON summaries (root, id);`);
      importOld(db, DatabaseSync, join(dir, 'copilot-mem.db'));
    }
    if (version < 2) {
      // Rows written before roots were recorded get one wherever their session's folder is known:
      // one pass per table, for just the sessions that need it.
      const sessions = db.prepare(`SELECT id, cwd FROM sessions WHERE cwd IS NOT NULL AND id IN
        (SELECT session_id FROM turns WHERE root IS NULL UNION SELECT session_id FROM observations WHERE root IS NULL
         UNION SELECT session_id FROM summaries WHERE root IS NULL)`).all();
      db.exec('CREATE TEMP TABLE IF NOT EXISTS session_root (sid TEXT PRIMARY KEY, root TEXT)');
      for (const s of sessions) db.prepare('INSERT OR REPLACE INTO session_root VALUES (?, ?)').run(s.id, projectOf(s.cwd).root);
      for (const t of ['turns', 'observations', 'summaries']) {
        db.exec(`UPDATE ${t} SET root = (SELECT root FROM session_root WHERE sid = ${t}.session_id)
          WHERE root IS NULL AND session_id IN (SELECT sid FROM session_root)`);
      }
      db.exec('DROP TABLE session_root');
    }
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function importOld(db, DatabaseSync, file) {
  if (!existsSync(file)) return;
  let old;
  try {
    old = new DatabaseSync(file, { readOnly: true });
    const notes = old.prepare(`SELECT project, type, coalesce(nullif(title, ''), substr(narrative, 1, 80), 'note') title, coalesce(narrative, '') narrative,
      coalesce(facts, '[]') facts, coalesce(files_read, '[]') files_read, coalesce(files_modified, '[]') files_modified, created_at FROM observations ORDER BY id`).all();
    const sums = old.prepare(`SELECT project, coalesce(request, '') request, coalesce(completed, '') completed, coalesce(learned, '') learned,
      coalesce(next_steps, '') next_steps, created_at FROM session_summaries ORDER BY id`).all();
    for (const o of notes) {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO observations
        (project, type, title, narrative, facts, files_read, files_modified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(o.project, o.type, o.title, o.narrative, o.facts, o.files_read, o.files_modified, o.created_at);
      index(db, 'obs', id, o.project, [o.title, o.narrative, ...list(o.facts)].join('\n'));
    }
    for (const s of sums) {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO summaries
        (project, request, completed, learned, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(s.project, s.request, s.completed, s.learned, s.next_steps, s.created_at);
      index(db, 'sum', id, s.project, [s.request, s.completed, s.learned, s.next_steps].join('\n'));
    }
    if (notes.length || sums.length) log(`imported ${notes.length} notes and ${sums.length} summaries from ${file}`);
  } catch (e) {
    log(`import from ${file} skipped: ${e.message}`);
  } finally {
    old?.close();
  }
}

const now = () => new Date().toISOString();
const day = (iso) => new Date(iso).toLocaleString('sv-SE').slice(0, 16); // local "YYYY-MM-DD HH:MM"
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const index = (db, kind, ref, project, body) =>
  db.prepare('INSERT INTO search (kind, ref, project, body) VALUES (?, ?, ?, ?)').run(kind, ref, project, body);
const pendingTurns = (db) => db.prepare("SELECT count(*) n FROM turns WHERE status = 'pending'").get().n;
// Rows of one project: by repository root, or by name for rows saved without one.
const MINE = '(root = ? OR (root IS NULL AND project = ?))';

const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const inside = (a, dir) => { try { return realpathSync(a).startsWith(realpathSync(dir) + sep); } catch { return false; } };

// One value from a git config file (includes are not followed); `section` as written in the brackets.
function gitConfig(dir, section, key) {
  let current = '';
  for (const raw of readFileSync(join(dir, 'config'), 'utf8').split('\n')) {
    const line = raw.trim();
    const head = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (head) { current = head[1].replace(/\s+/g, ' ').toLowerCase(); continue; }
    const kv = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && current === section.toLowerCase() && kv[1].toLowerCase() === key) return kv[2];
  }
  return null;
}

// One spelling per repository: git@host:owner/repo.git, https://user@host:443/owner/repo/ and
// ssh://git@host:22/owner/repo all become host/owner/repo.
function originKey(url) {
  let u = String(url).trim().replace(/\s+[;#].*$/, '').replace(/^"(.*)"$/, '$1');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  if (scheme.test(u)) u = u.replace(scheme, '').replace(/^[^@/]*@/, '').replace(/^([^/:]+):(?:22|80|443)(?=\/|$)/, '$1');
  else u = u.replace(/^[^@/]*@/, '').replace(/^([^/:]+):(?!\/)/, '$1/'); // scp-like [user@]host:path
  return u.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

// Project = the git repository a folder belongs to. `root` identifies it: its origin URL (so
// other clones and linked worktrees share memory), else its path. `path` is the repository's
// folder and `name` its folder name, the label shown and searched.
function projectOf(cwd) {
  const here = resolve(cwd);
  for (let d = here; ; d = dirname(d)) {
    const git = join(d, '.git');
    if (existsSync(git)) {
      let top = d, gitdir = git; // .git is the repository folder itself...
      try {
        // ...or a file, "gitdir: <dir>", trusted only as git itself writes it: a linked worktree
        // whose entry (<common dir>/worktrees/<name>/gitdir) points back here, or a git dir
        // inside this folder or whose core.worktree is this folder (submodules, --separate-git-dir).
        const target = resolve(d, /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, 'utf8'))[1]);
        gitdir = null;
        const wt = /^(.+)[\\/]worktrees[\\/][^\\/]+$/.exec(target);
        if (wt && same(resolve(target, readFileSync(join(target, 'gitdir'), 'utf8').trim()), git)) {
          gitdir = wt[1];
          top = /^\.(git|bare)$/.test(basename(gitdir)) ? dirname(gitdir) : gitdir.replace(/\.git$/, '');
        } else if (!wt && (inside(target, d) || same(resolve(target, gitConfig(target, 'core', 'worktree') ?? '\0'), d))) {
          gitdir = target;
        }
      } catch {}
      let origin = '';
      try { if (gitdir && existsSync(join(gitdir, 'HEAD'))) origin = originKey(gitConfig(gitdir, 'remote "origin"', 'url') ?? ''); } catch {}
      return { name: basename(top) || 'root', root: origin ? `origin:${origin}` : top, path: top };
    }
    if (dirname(d) === d) return { name: basename(here) || 'root', root: here, path: here };
  }
}

// A project's rows are filed under its current identity. Rows filed under its folder (before it
// had a remote, or by an earlier version) and, for a repository without a remote, rows of a
// same-named repository whose folder is gone (it was moved here) are re-filed under it once.
function adopt(db, { name, root, path }) {
  if (!root) return;
  const from = new Set(path && path !== root ? [path] : []);
  if (root.startsWith('/')) {
    for (const r of db.prepare("SELECT DISTINCT root FROM observations WHERE project = ? AND root LIKE '/%' AND root != ?").all(name, root)) {
      if (!existsSync(r.root)) from.add(r.root);
    }
  }
  for (const old of from) for (const t of ['turns', 'observations', 'summaries']) db.prepare(`UPDATE ${t} SET root = ? WHERE root = ?`).run(root, old);
}

// ---- recording (hooks) ----------------------------------------------------------

const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s;
};

// One tool call from a PostToolUse / PostToolUseFailure payload
// ({tool_name, tool_input, tool_result: {text_result_for_llm}} or {..., error}).
// Long values are cut here: the writer only reads the first few hundred characters.
function toolEvent(p, failed) {
  const input = parse(p.tool_input ?? p.toolArgs ?? {});
  const result = parse(p.tool_result ?? p.tool_response ?? p.toolResult);
  const output = failed ? `error: ${p.error ?? result?.text_result_for_llm ?? 'tool failed'}` : result?.text_result_for_llm ?? result ?? '';
  const short = input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 2000) : v]))
    : input;
  return {
    tool: String(p.tool_name ?? p.toolName ?? 'tool'),
    input: JSON.stringify(short ?? '').length > 8000 ? clip(short, 8000) : short, // big nested inputs
    output: clip(output, 4000),
    failed,
  };
}

// Copilot's transcript is <COPILOT_HOME>/session-state/<id>/events.jsonl. The
// turn's reply is the last assistant message after the latest user message
// (anything before that belongs to an earlier turn) that calls no tools
// (messages with toolRequests are the agent's intermediate steps).
function lastAssistantMessage(transcriptPath) {
  let last = '';
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'user.message') last = '';
        else if (e.type === 'assistant.message' && !e.data?.toolRequests?.length
          && typeof e.data?.content === 'string' && e.data.content.trim()) last = e.data.content;
      } catch {}
    }
  } catch {}
  return last;
}

// Copilot can fire Stop a few ms before it flushes the final message to disk.
async function awaitAssistantMessage(transcriptPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const msg = lastAssistantMessage(transcriptPath);
    if (msg || Date.now() > deadline) return msg;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A turn = the latest prompt, the tool calls since the previous turn, and the reply.
function closeTurn(db, sid, { name, root }, cwd, reply) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const open = db.prepare('SELECT data FROM events WHERE session_id IS ? AND turn_id IS NULL').all(sid).map((r) => JSON.parse(r.data));
    const calls = open.filter((e) => !e.recall).length;
    // Nothing happened, or the turn only used memory and found what it needed: nothing new to
    // remember. A lookup that came back empty keeps the turn (its reply may hold new decisions).
    const missed = open.some((e) => e.recall && !e.found);
    if (!calls && !missed && (open.length || !reply.trim())) {
      db.prepare('UPDATE events SET turn_id = 0 WHERE session_id IS ? AND turn_id IS NULL').run(sid);
      db.exec('COMMIT');
      return false;
    }
    const prompt = db.prepare('SELECT text FROM prompts WHERE session_id IS ? ORDER BY id DESC LIMIT 1').get(sid)?.text ?? '';
    const { lastInsertRowid: id } = db.prepare('INSERT INTO turns (session_id, project, root, cwd, prompt, reply, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sid, name, root, cwd, prompt, reply, now());
    db.prepare('UPDATE events SET turn_id = ? WHERE session_id IS ? AND turn_id IS NULL').run(id, sid);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function handle(db, event, p, cfg, kick = startWriter) {
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  const proj = projectOf(cwd);
  const sid = p.session_id ?? p.sessionId ?? null;
  const t = now();
  const addEvent = (ev) => db.prepare('INSERT INTO events (session_id, project, data, created_at) VALUES (?, ?, ?, ?)').run(sid, proj.name, JSON.stringify(ev), t);
  if (sid) db.prepare('INSERT OR IGNORE INTO sessions (id, project, cwd, started_at) VALUES (?, ?, ?, ?)').run(sid, proj.name, cwd, t);
  switch (event) {
    case 'SessionStart':
      if (pendingTurns(db)) kick(); // catch up on turns left over from earlier sessions
      adopt(db, proj);
      return { additionalContext: sessionContext(db, proj, cfg) };
    case 'UserPromptSubmit': {
      const text = String(p.prompt ?? '').trim();
      if (!text) return {};
      // Tool calls still open belong to the previous prompt (a turn that was interrupted, or
      // cut off by a crash before --resume): close them under it.
      if (closeTurn(db, sid, proj, cwd, '')) kick();
      const { lastInsertRowid: id } = db.prepare('INSERT INTO prompts (session_id, project, text, created_at) VALUES (?, ?, ?, ?)').run(sid, proj.name, text, t);
      index(db, 'prompt', id, proj.name, text);
      return {};
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const ev = toolEvent(p, event === 'PostToolUseFailure');
      const skip = new Set(cfg.COPILOT_MEM_SKIP_TOOLS.toLowerCase().split(',').map((s) => s.trim()));
      // Copilot using its memory is not itself worth remembering; the marker lets closeTurn
      // drop turns that did nothing else.
      if (/copilot-mem\.mjs["']?\s+(search|timeline|get|save)\b/.test(ev.input?.command ?? '')) {
        const out = String(ev.output).replace(/<shellId:[^>]*>\s*$/, ''); // Copilot's shell trailer
        addEvent({ tool: 'memory', recall: true, found: !ev.failed && !/^\s*(?:(?:no matches|\S+: not found)\s*)+$/.test(out) });
      }
      else if (!skip.has(ev.tool.toLowerCase())) addEvent(ev);
      return {};
    }
    case 'SubagentStop': {
      const msg = String(p.last_assistant_message ?? p.result ?? '').trim();
      if (msg) addEvent({ tool: 'subagent', input: { agent: p.agent_name ?? p.agent_type ?? '' }, output: clip(msg, 4000), failed: false });
      return {};
    }
    case 'Stop': {
      const reply = String(p.last_assistant_message ?? '') || (typeof p.transcript_path === 'string' ? await awaitAssistantMessage(p.transcript_path) : '');
      if (closeTurn(db, sid, proj, cwd, reply)) kick();
      return {};
    }
    case 'SessionEnd':
      if (sid) db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(t, sid);
      closeTurn(db, sid, proj, cwd, ''); // tool calls from a turn that never reached Stop
      if (pendingTurns(db)) kick();
      return {};
  }
  return {};
}

// Fire and forget: the hook returns at once, the writer carries on in the background.
function startWriter() {
  const [cmd, args] = sandboxed(process.execPath, [SELF, 'writer']);
  spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: tmpdir() }).on('error', (e) => log(`writer spawn: ${e.message}`)).unref();
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function hook(event) {
  // Memory must never break the agent: every path exits 0 with valid JSON.
  let out = {};
  try {
    const raw = await readStdin(); // always drain stdin, or Copilot's write of a big payload fails
    // Installed both as a plugin and via settings.json: only the settings.json hooks record.
    if (process.env.COPILOT_PLUGIN_ROOT && settingsHasHooks()) return;
    const cfg = readConfig();
    if (cfg.COPILOT_MEM_LOG_LEVEL === 'DEBUG') log(`hook ${event} in=${raw.slice(0, 4000)}`);
    const p = JSON.parse(raw || '{}');
    out = await handle(await openDb(), event, p && typeof p === 'object' ? p : {}, cfg);
  } catch (e) {
    log(`hook ${event}: ${e.stack ?? e.message}`);
  } finally {
    process.stdout.write(JSON.stringify(out ?? {}) + '\n');
  }
}

function log(msg) {
  try {
    mkdirSync(join(DATA, 'logs'), { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA, 'logs', 'copilot-mem.log'), `${now()} ${msg}\n`, { flag: 'a', mode: 0o600 });
  } catch {}
}

// ---- note writer ------------------------------------------------------------------

const TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision'];

const WRITER_PROMPT = `You keep the long-term memory of a coding agent (GitHub Copilot CLI). You get one turn of a session: the user's request, the tool calls the agent made with their results, and the agent's final reply.

Write down what someone returning to this project later would want to know: what was built, fixed or changed, and why; decisions and their reasons; how something works; problems hit and how they were solved.

Rules:
- Each observation title states the specific outcome, not the activity. Good: "API client retries failed requests 3 times, 500 ms apart". Bad: "File creation and verification".
- Facts keep exact names and values from the turn: files, functions, settings, ports, versions, commands, error messages.
- Types: bugfix = broken behaviour in the project was fixed; feature = new capability; refactor = restructured without changing behaviour; change = other edits (config, docs, dependencies); discovery = learned how something works; decision = a choice and its reason.
- Skip routine file reads, directory listings, a tool error that taught nothing, and chit-chat.
- Never add anything that is not in the turn. Describe code and data in words; do not paste JSON or code.
- Don't repeat what is listed under "Already in memory".

Reply with JSON only, in this shape:
{"observations": [{"type": "...", "title": "at most 80 characters", "narrative": "one to three sentences", "facts": ["..."]}],
 "summary": {"request": "the user's request in one sentence", "completed": "what got done", "learned": "what was learned, or empty", "next_steps": "what is left to do, or empty"}}

Use zero to three observations; zero when nothing new worth remembering happened. Set "summary" to null when the turn was trivial (a greeting, a one-line answer, an answer taken from memory).`;

// Read-only lookups: their failures (file not found, no match) are left out, since small
// models turn them into bogus "bugfix" notes, and they get the space that is left over.
const LOOKUP = /^(read|view|glob|grep|ls)$/i;
const cut = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? clip(x, 300) : x]))
  : v);

// What the writer model sees, trimmed to fit a small local context window.
function turnText(turn, all, known = []) {
  const events = all.filter((e) => !e.recall && !(e.failed && LOOKUP.test(e.tool)));
  const lines = events.map((e, i) => `${i + 1}. ${e.tool}${e.failed ? ' (failed)' : ''} ${clip(cut(e.input), 900)}\n   -> ${clip(e.output, LOOKUP.test(e.tool) ? 150 : 600)}`);
  let budget = 8000;
  const keep = new Set();
  for (const lookups of [false, true]) { // calls that change things first, then lookups; call order kept
    lines.forEach((l, i) => { if (LOOKUP.test(events[i].tool) === lookups && l.length <= budget) { budget -= l.length; keep.add(i); } });
  }
  const shown = lines.filter((_, i) => keep.has(i));
  if (shown.length < lines.length) shown.push(`(${lines.length - shown.length} more tool calls not shown)`);
  const text = [
    `Project: ${turn.project}`,
    known.length && `Already in memory:\n${known.map((t) => `- ${t}`).join('\n')}`,
    `User request: ${clip(turn.prompt || '(not recorded)', 2000)}`,
    shown.length ? `Tool calls:\n${shown.join('\n')}` : 'Tool calls: none',
    `Final reply: ${clip(turn.reply || '(not recorded)', 2000)}`,
  ].filter(Boolean).join('\n\n');
  return turn.cwd ? text.replaceAll(`${turn.cwd}/`, '') : text;
}

// Small local models wrap JSON in prose, code fences or <think> blocks, and bend its shape:
// take the outermost object and flatten whatever came back into one-line strings.
function parseNotes(reply) {
  const body = String(reply).replace(/^\s*<think>[\s\S]*?<\/think>/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model reply has no JSON object');
  const j = JSON.parse(body.slice(start, end + 1));
  const flat = (v) => (Array.isArray(v) ? v.map(flat).join('; ') : v && typeof v === 'object' ? Object.values(v).map(flat).join(', ') : v == null ? '' : String(v));
  const str = (v, n) => oneLine(flat(v)).slice(0, n);
  const observations = [].concat(j.observations ?? []).slice(0, 5)
    .map((o) => ({
      type: TYPES.includes(o?.type) ? o.type : 'change',
      title: str(o?.title, 120),
      narrative: str(o?.narrative, 1500),
      facts: [].concat(o?.facts ?? []).map((f) => str(f, 300)).filter(Boolean).slice(0, 8),
    }))
    .filter((o) => o.title);
  const s = typeof j.summary === 'string' ? { completed: j.summary } : j.summary && typeof j.summary === 'object' ? j.summary : {};
  const summary = { request: str(s.request, 500), completed: str(s.completed, 1500), learned: str(s.learned, 1500), next_steps: str(s.next_steps, 500) };
  return { observations, summary: summary.request || summary.completed ? summary : null };
}

// Files a turn read and changed, straight from the tool inputs (more reliable than asking the model).
const MODIFIES = /edit|create|write|replace|patch|insert|delete|rename|move/i;
function filesTouched(events, cwd) {
  const read = new Set(), modified = new Set();
  for (const e of events) {
    if (e.failed || e.recall) continue;
    const inp = e.input && typeof e.input === 'object' ? e.input : {};
    for (const f of [inp.path, inp.file_path, inp.filePath, ...(Array.isArray(inp.paths) ? inp.paths : [])]) {
      if (typeof f !== 'string' || !f) continue;
      const rel = cwd && isAbsolute(f) && !relative(cwd, f).startsWith('..') ? relative(cwd, f) || '.' : f;
      (MODIFIES.test(e.tool) ? modified : read).add(rel);
    }
  }
  for (const f of modified) read.delete(f);
  return { read: [...read].slice(0, 20), modified: [...modified].slice(0, 20) };
}

async function writeTurn(db, turn, ask) {
  const events = db.prepare('SELECT data FROM events WHERE turn_id = ? ORDER BY id').all(turn.id).map((r) => JSON.parse(r.data));
  // The repository's identity now (it may have gained a remote since the turn was queued).
  const proj = turn.cwd ? projectOf(turn.cwd) : { name: turn.project, root: turn.root, path: null };
  adopt(db, proj);
  const root = proj.root;
  const known = db.prepare(`SELECT title FROM observations WHERE ${MINE} ORDER BY id DESC LIMIT 20`).all(root, turn.project).map((r) => r.title);
  const notes = parseNotes(await ask(WRITER_PROMPT, turnText(turn, events, known)));
  const { read, modified } = filesTouched(events, turn.cwd);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Claim the turn inside the transaction: two writers can never both save it.
    if (!db.prepare("UPDATE turns SET status = 'done', error = NULL WHERE id = ? AND status = 'pending'").run(turn.id).changes) return db.exec('ROLLBACK');
    for (const o of notes.observations) {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO observations
        (session_id, project, root, type, title, narrative, facts, files_read, files_modified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turn.session_id, turn.project, root, o.type, o.title, o.narrative, JSON.stringify(o.facts), JSON.stringify(read), JSON.stringify(modified), turn.created_at);
      index(db, 'obs', id, turn.project, [o.title, o.narrative, ...o.facts, ...modified].join('\n'));
    }
    const s = notes.summary;
    if (s) {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO summaries
        (session_id, project, root, request, completed, learned, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turn.session_id, turn.project, root, s.request, s.completed, s.learned, s.next_steps, turn.created_at);
      index(db, 'sum', id, turn.project, [s.request, s.completed, s.learned, s.next_steps].join('\n'));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Write every pending turn, oldest first. 'unavailable' = model server down, misconfigured or
// model missing: the turns stay queued for the next hook to retry. A turn whose reply was
// unusable is tried again on a later run, never back to back. A turn is only updated while it
// is still pending (another writer may have finished it meanwhile).
async function drain(db, ask, report = log) {
  let after = 0;
  for (;;) {
    const turn = db.prepare("SELECT * FROM turns WHERE status = 'pending' AND id > ? ORDER BY id LIMIT 1").get(after);
    if (!turn) return 'done';
    try {
      await writeTurn(db, turn, ask);
    } catch (e) {
      if (e.unavailable) {
        db.prepare("UPDATE turns SET error = ? WHERE id = ? AND status = 'pending'").run(e.message, turn.id);
        return 'unavailable';
      }
      const attempts = turn.attempts + 1; // unusable reply: try twice more, then give up on this turn
      db.prepare("UPDATE turns SET attempts = ?, error = ?, status = ? WHERE id = ? AND status = 'pending'")
        .run(attempts, e.message.slice(0, 500), attempts >= 3 ? 'failed' : 'pending', turn.id);
      report(`writer: turn ${turn.id}: ${e.message}`);
      after = turn.id;
    }
  }
}

// Ollama "cloud" models run on ollama.com behind the local server, so loopback alone would not
// keep a turn on this machine. Caught by name, and for renamed copies by asking Ollama, which
// resolves the name exactly as it will for the request (other servers have no such route).
async function cloudModel(base, model) {
  if (/[:-]cloud$/i.test(model)) return true;
  const info = await fetch(`${base.replace(/\/v1$/, '')}/api/show`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return info ? !!(info.remote_host || info.remote_model) : null; // null: not Ollama, can't tell
}

// Model names as Ollama compares them: case-insensitive, ":latest" when no tag is given.
const modelKey = (n) => (String(n).includes(':') ? String(n) : `${n}:latest`).toLowerCase();

// The text of an OpenAI-style streamed reply (server-sent events), and whether it looked like one.
function sseText(body) {
  let openai = false, text = '';
  for (const raw of String(body).split('\n')) {
    const line = raw.trim();
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    let j;
    try { j = JSON.parse(data); } catch { continue; } // not a chunk we understand
    openai ||= Array.isArray(j?.choices);
    text += j?.choices?.[0]?.delta?.content ?? '';
  }
  return { openai, text };
}

async function chat(cfg, system, user) {
  const base = modelBase(cfg), model = String(cfg.COPILOT_MEM_OPENAI_COMPAT_MODEL ?? '').trim();
  if (!/^\S+$/.test(model)) throw unavailable(`COPILOT_MEM_OPENAI_COMPAT_MODEL is not a model name: "${model}"`);
  if (await cloudModel(base, model)) throw unavailable(`${model} is a cloud model; the note writer only uses models that run on this machine`);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      redirect: 'manual', // a redirect could point anywhere: refuse it
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.2, stream: true, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(30 * 60_000), // the model may be busy serving Copilot itself
    });
  } catch (e) {
    // Includes waiting too long for the answer to start: the server is busy (e.g. serving Copilot).
    throw unavailable(`model server unreachable at ${base} (${e.cause?.code ?? e.name})`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`model ${model}: HTTP ${res.status} ${body}`);
    // Only a request this turn got wrong counts against the turn. Anything else (model not
    // pulled or misnamed, a context or feature the server lacks, auth, rate limit, redirect,
    // server trouble) is a setup problem: the queue waits until it is fixed.
    if (![400, 413, 422].includes(res.status) || /model|context|token|response_format|json|support/i.test(body)) err.unavailable = true;
    throw err;
  }
  // Streamed, so a long answer isn't cut off by fetch's five-minute wait for the first byte.
  let body = '';
  try {
    if (res.body) for await (const s of res.body.pipeThrough(new TextDecoderStream())) body += s;
  } catch (e) {
    const why = `(${e.cause?.code ?? e.name})`;
    // Nothing but keep-alives arrived: the server is busy, so the turn waits. The answer started,
    // then stalled or ran too long: counted against this turn, so it can't block the queue forever.
    if (!body.replace(/^:.*$/gm, '').trim()) throw unavailable(`model ${model}: no answer yet ${why}`);
    throw new Error(`model ${model}: the reply stalled or took too long ${why}`);
  }
  let reply = { openai: false, text: '' };
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) reply = sseText(body);
  else try { const j = JSON.parse(body); reply = { openai: Array.isArray(j?.choices), text: j?.choices?.[0]?.message?.content ?? '' }; } catch {}
  if (!reply.openai) throw unavailable(`${base} did not answer like an OpenAI-compatible server`);
  return reply.text;
}

const alive = (pid) => {
  try { return pid > 0 && process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
};

// One writer at a time, so a busy local model isn't hit twice. The lock holds
// the writer's pid and is touched every turn; a dead or silent holder is replaced.
function takeLock(lock) {
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid = 0, age = Infinity;
    try { pid = Number(readFileSync(lock, 'utf8')); age = Date.now() - statSync(lock).mtimeMs; } catch {}
    if ((alive(pid) || !pid) && age < 15 * 60_000) return false; // no pid yet = a writer is creating it
    rmSync(lock, { force: true });
  }
  return false;
}

async function writer() {
  process.env.NO_PROXY = process.env.no_proxy = '*'; // every request here is to loopback: never through a proxy
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const lock = join(DATA, 'writer.lock');
  if (!takeLock(lock)) return;
  const own = () => { try { return Number(readFileSync(lock, 'utf8')) === process.pid; } catch { return false; } };
  // Keep the lock fresh while a long request is in flight, so it is never taken for stale.
  const beat = setInterval(() => { try { if (own()) utimesSync(lock, new Date(), new Date()); } catch {} }, 60_000);
  beat.unref();
  let db, result;
  try {
    db = await openDb();
    const cfg = readConfig();
    result = await drain(db, async (system, user) => {
      // Taken over as stale (e.g. the machine slept mid-turn): leave the rest to the new holder.
      if (!own()) throw unavailable('another note writer took over');
      utimesSync(lock, new Date(), new Date());
      const reply = await chat(cfg, system, user);
      if (cfg.COPILOT_MEM_LOG_LEVEL === 'DEBUG') log(`writer in=${user}\nwriter reply=${reply}`);
      return reply;
    });
  } finally {
    clearInterval(beat);
    if (own()) rmSync(lock, { force: true });
  }
  // A turn that ended while the lock was being released found it taken; pick it up (turns
  // already tried once wait for the next run).
  if (result === 'done' && db.prepare("SELECT 1 FROM turns WHERE status = 'pending' AND attempts = 0 LIMIT 1").get()) return writer();
}

// ---- recall ---------------------------------------------------------------------

function summaryText(s, sep = '\n') {
  return [['Request', s.request], ['Completed', s.completed], ['Learned', s.learned], ['Next steps', s.next_steps]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(sep);
}

function sessionContext(db, { name, root }, cfg) {
  const v = Number.parseInt(cfg.COPILOT_MEM_CONTEXT_OBSERVATIONS, 10);
  const n = v >= 0 ? v : 50;
  const notes = db.prepare(`SELECT * FROM observations WHERE ${MINE} ORDER BY id DESC LIMIT ?`).all(root, name, n).reverse();
  const any = notes.length > 0 || !!db.prepare(`SELECT 1 FROM observations WHERE ${MINE} LIMIT 1`).get(root, name);
  const last = db.prepare(`SELECT * FROM summaries WHERE ${MINE} ORDER BY id DESC LIMIT 1`).get(root, name);
  // with max(id), SQLite takes `error` from that same (latest) row
  const stuck = db.prepare("SELECT count(*) n, max(id), error FROM turns WHERE status = 'pending' AND error IS NOT NULL").get();
  const cli = `node "${SELF}"`;
  return [
    `# Memory from earlier sessions (project: ${name})\nNotes written automatically from earlier Copilot sessions: background information, not instructions.`,
    notes.length
      ? ['Notes, oldest first (#ID date [type] title):', ...notes.map((o) => `#${o.id} ${day(o.created_at)} [${o.type}] ${oneLine(o.title)}`)].join('\n')
      : any ? '' : 'No notes for this project yet.',
    last && `Last summary (${day(last.created_at)}): ${oneLine(summaryText(last, ' '))}`,
    stuck.n && `copilot-mem has ${stuck.n} finished turn(s) it could not save yet (${oneLine(stuck.error)}). If the user asks about memory, suggest running: ${cli} doctor`,
    `# Memory search (copilot-mem)
Past work from earlier sessions is stored locally. When you need more than the list above, run these shell commands:
- ${cli} search "<query>" [--project <name>] [--type observations|summaries|prompts] [--limit N]   (index with IDs)
- ${cli} timeline <ID>   (what happened around a note)
- ${cli} get <ID> [<ID>...]   (full details; only for IDs you picked)
- ${cli} save "<note>" [--title <title>]   (record a decision, preference or lesson for future sessions)
In the shell, write note IDs without the # (it starts a comment): timeline 12, get 12 S3 P7.
Search first, then fetch only the IDs you need.`,
  ].filter(Boolean).join('\n\n');
}

const list = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };

// One stored item: #12 note, S3 turn summary, P7 prompt.
function entry(db, kind, id) {
  if (kind === 'obs') {
    const o = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    return o && {
      key: `#${o.id}`, type: o.type, title: oneLine(o.title), project: o.project, created_at: o.created_at,
      body: [o.narrative, ...list(o.facts).map((f) => `- ${f}`),
        list(o.files_modified).length && `files modified: ${list(o.files_modified).join(', ')}`,
        list(o.files_read).length && `files read: ${list(o.files_read).join(', ')}`].filter(Boolean).join('\n'),
    };
  }
  if (kind === 'sum') {
    const s = db.prepare('SELECT * FROM summaries WHERE id = ?').get(id);
    return s && { key: `S${s.id}`, type: 'summary', title: oneLine(s.request || s.completed), project: s.project, created_at: s.created_at, body: summaryText(s) };
  }
  const p = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  return p && { key: `P${p.id}`, type: 'prompt', title: oneLine(p.text).slice(0, 120), project: p.project, created_at: p.created_at, body: p.text };
}

const line = (e) => `${e.key} ${day(e.created_at)} [${e.type}] ${e.title} (${e.project})`;
const KEY_KIND = { '#': 'obs', S: 'sum', P: 'prompt' };
function byKey(db, key) {
  const m = /^([#SP]?)(\d+)$/i.exec(String(key).trim());
  return m ? entry(db, KEY_KIND[m[1].toUpperCase() || '#'], Number(m[2])) : null;
}

const TYPE_KIND = { observations: 'obs', summaries: 'sum', sessions: 'sum', prompts: 'prompt' };
function search(db, query, { project, type, limit } = {}) {
  if (type && !TYPE_KIND[type]) throw new Error('--type must be observations, summaries or prompts');
  const terms = String(query).match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return [];
  const where = ['search MATCH ?'], args = [terms.map((t) => `"${t}"`).join(' OR ')];
  if (project) where.push('project = ?'), args.push(project);
  if (type) where.push('kind = ?'), args.push(TYPE_KIND[type]);
  return db.prepare(`SELECT kind, ref FROM search WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`)
    .all(...args, Number(limit) || 20).map((r) => entry(db, r.kind, r.ref)).filter(Boolean);
}

function timeline(db, key, before = 5, after = 5) {
  const id = Number(String(key).replace(/^#/, ''));
  const o = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  if (!o) throw new Error(`${key}: not found (timeline takes a note ID such as 12)`);
  const notes = [ // from the same repository only
    ...db.prepare(`SELECT * FROM observations WHERE ${MINE} AND id < ? ORDER BY id DESC LIMIT ?`).all(o.root, o.project, id, before).reverse(),
    o,
    ...db.prepare(`SELECT * FROM observations WHERE ${MINE} AND id > ? ORDER BY id LIMIT ?`).all(o.root, o.project, id, after),
  ];
  const span = notes.map((n) => n.created_at).sort(); // ids and times can disagree (a save while old turns wait)
  const sums = db.prepare(`SELECT * FROM summaries WHERE ${MINE} AND created_at BETWEEN ? AND ? ORDER BY id`).all(o.root, o.project, span[0], span.at(-1));
  return [
    ...notes.map((n) => ({ at: n.created_at, text: `${n.id === id ? '→' : ' '} #${n.id} ${day(n.created_at)} [${n.type}] ${oneLine(n.title)}` })),
    ...sums.map((s) => ({ at: s.created_at, text: `  S${s.id} ${day(s.created_at)} [summary] ${oneLine(s.completed || s.request)}` })),
  ].sort((a, b) => a.at.localeCompare(b.at)).map((r) => r.text).join('\n');
}

function save(db, text, { title, project } = {}) {
  const proj = project ? { name: project, root: null } : projectOf(process.cwd());
  const head = oneLine(title || text.split('\n')[0]).slice(0, 120);
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO observations
    (project, root, type, title, narrative, facts, files_read, files_modified, created_at) VALUES (?, ?, 'note', ?, ?, '[]', '[]', '[]', ?)`)
    .run(proj.name, proj.root, head, text, now());
  index(db, 'obs', id, proj.name, `${head}\n${text}`);
  return id;
}

function parseArgs(args) {
  const opts = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { opts, pos };
}

async function memoryCommand(cmd, args) {
  const { opts, pos } = parseArgs(args);
  const db = await openDb();
  switch (cmd) {
    case 'search': {
      if (!pos.length) throw new Error('usage: search "<query>" [--project p] [--type observations|summaries|prompts] [--limit n]');
      const hits = search(db, pos.join(' '), opts);
      return console.log(hits.length ? hits.map(line).join('\n') : 'no matches');
    }
    case 'timeline':
      if (!pos[0]) throw new Error('usage: timeline <ID>');
      return console.log(timeline(db, pos[0], Number(opts.before ?? 5), Number(opts.after ?? 5)));
    case 'get':
      if (!pos.length) throw new Error('usage: get <ID> [<ID>...]');
      for (const k of pos) {
        const e = byKey(db, k);
        console.log(e ? `${line(e)}\n${e.body}\n` : `${k}: not found\n`);
      }
      return;
    case 'save':
      if (!pos.length) throw new Error('usage: save "<note>" [--title t] [--project p]');
      return console.log(`saved #${save(db, pos.join(' '), opts)}`);
  }
}

// ---- web viewer -----------------------------------------------------------------

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--card:#f6f8fa;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#f0f6fc;--muted:#9198a1;--border:#3d444d;--card:#151b23;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
h1{font-size:16px;margin:0;flex:1}input{width:min(360px,100%);padding:5px 12px;font:inherit;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)}
nav{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px}nav a{color:var(--accent);text-decoration:none;padding:2px 10px;border:1px solid var(--border);border-radius:999px}
nav a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--bg)}main{padding:0 16px 32px;max-width:960px}
details{margin:8px 0;border:1px solid var(--border);border-radius:6px;background:var(--card)}summary{cursor:pointer;padding:8px 12px}
.k,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.k,time{color:var(--muted)}time{font-size:12px;margin-left:6px}
.t{font-size:12px;padding:0 6px;border:1px solid var(--border);border-radius:999px;color:var(--muted)}
pre{white-space:pre-wrap;margin:0;padding:4px 12px 12px;font-size:13px}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(db, q, project, token) {
  const projects = db.prepare('SELECT project FROM observations UNION SELECT project FROM summaries ORDER BY 1').all().map((r) => r.project);
  const items = q
    ? search(db, q, { project, limit: 100 })
    : db.prepare(`SELECT 'obs' kind, id, created_at FROM observations ${project ? 'WHERE project = ?' : ''}
        UNION ALL SELECT 'sum', id, created_at FROM summaries ${project ? 'WHERE project = ?' : ''}
        ORDER BY created_at DESC, kind LIMIT 100`).all(...(project ? [project, project] : [])).map((r) => entry(db, r.kind, r.id));
  const href = (p) => `?${new URLSearchParams({ t: token, ...(q && { q }), ...(p && { project: p }) })}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>copilot-mem</title><link rel="icon" href="/icon.svg"><style>${CSS}</style></head><body>
<header><img src="/icon.svg" alt="" width="24" height="24"><h1>copilot-mem</h1>
<form role="search"><input type="hidden" name="t" value="${esc(token)}"><input type="search" name="q" value="${esc(q)}" placeholder="Search memory" aria-label="Search memory">${project ? `<input type="hidden" name="project" value="${esc(project)}">` : ''}</form></header>
<nav aria-label="Projects"><a href="${esc(href(''))}"${project ? '' : ' aria-current="page"'}>All projects</a>${projects.map((p) => `<a href="${esc(href(p))}"${p === project ? ' aria-current="page"' : ''}>${esc(p)}</a>`).join('')}</nav>
<main>${items.length ? items.map((e) => `<details><summary><span class="k">${esc(e.key)}</span> <span class="t">${esc(e.type)}</span> ${esc(e.title)}<time>${esc(day(e.created_at))} · ${esc(e.project)}</time></summary><pre>${esc(e.body)}</pre></details>`).join('\n') : '<p>Nothing here yet.</p>'}</main>
</body></html>`;
}

async function viewer() {
  if (process.platform === 'darwin' && !process.env.COPILOT_MEM_SANDBOXED) {
    const [cmd, args] = sandboxed(process.execPath, [SELF, 'viewer']);
    process.exit(spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, COPILOT_MEM_SANDBOXED: '1' } }).status ?? 0);
  }
  const db = await openDb();
  const port = Number(readConfig().COPILOT_MEM_VIEWER_PORT);
  let icon = null;
  try { icon = readFileSync(join(dirname(SELF), 'theme', 'copilot.svg')); } catch {}
  // Other accounts on this machine can reach 127.0.0.1 too: every page needs the token from the
  // printed link. It travels in the URL (pages carry no referrer), not a cookie, which the
  // browser would also send to every other service on 127.0.0.1.
  const token = randomBytes(16).toString('hex');
  createServer((req, res) => {
    // A Host check, so no website can read it through DNS rebinding.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return res.writeHead(403).end();
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return res.writeHead(400).end(); }
    if (url.pathname === '/icon.svg') return icon ? res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(icon) : res.writeHead(404).end();
    if (url.searchParams.get('t') !== token) {
      return res.writeHead(403, { 'content-type': 'text/plain' }).end('Open the link printed by `copilot-mem.mjs viewer`.');
    }
    if (url.pathname !== '/') return res.writeHead(404).end();
    try {
      const html = page(db, url.searchParams.get('q') ?? '', url.searchParams.get('project') ?? '', token);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      }).end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(e.message);
    }
  }).on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `port ${port} is in use (a copilot-mem 1.0 worker still running?); stop it, or set COPILOT_MEM_VIEWER_PORT`
      : `viewer: ${e.message}`);
    process.exit(1);
  }).listen(port, '127.0.0.1', () => console.log(`copilot-mem viewer: http://127.0.0.1:${port}/?t=${token}  (works while this runs; Ctrl+C to stop)`));
}

// ---- install / doctor ---------------------------------------------------------------

const HOOK_TIMEOUTS = { SessionStart: 30, UserPromptSubmit: 10, PostToolUse: 10, PostToolUseFailure: 10, Stop: 30, SubagentStop: 10, SessionEnd: 10 };

// Our entries are exactly `node "<path>/copilot-mem.mjs" hook <Event>`; other hooks
// (copilot-memo-sync.sh and the like) are never touched.
const ours = (group) => (group?.hooks ?? []).some((h) => /copilot-mem\.mjs["']? hook \w+/.test(h?.command ?? ''));

// Hooks go straight into Copilot's settings.json; other settings and other hooks are left alone.
function withHooks(settings, script) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [ev, timeout] of Object.entries(HOOK_TIMEOUTS)) {
    hooks[ev] = [...(hooks[ev] ?? []).filter((g) => !ours(g)), { matcher: '*', hooks: [{ type: 'command', command: `node "${script}" hook ${ev}`, timeout }] }];
  }
  return { ...settings, hooks };
}

// Never overwrite a settings file we can't read: it holds the user's other settings.
function readSettings() {
  if (!existsSync(COPILOT_SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(COPILOT_SETTINGS, 'utf8'));
  } catch (e) {
    throw new Error(`can't read ${COPILOT_SETTINGS} as plain JSON (${e.message}). If it has comments, remove them or edit the hooks by hand, then run this again`);
  }
}

// Written whole or not at all, keeping the file's permissions; a symlinked file stays linked.
function writeSettings(settings) {
  const target = existsSync(COPILOT_SETTINGS) ? realpathSync(COPILOT_SETTINGS) : COPILOT_SETTINGS;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'wx' });
  renameSync(tmp, target);
}

// Are there active settings.json hooks pointing at a copilot-mem.mjs that exists? Copilot
// accepts comments in settings.json, so they are stripped (outside strings) before parsing.
function settingsHasHooks(file = COPILOT_SETTINGS) {
  let settings;
  try {
    const text = readFileSync(file, 'utf8');
    settings = JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '').replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return false;
  }
  return Object.values(settings?.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).some((h) => {
    const m = /(?:"([^"]+)"|'([^']+)'|(\S+))\s+hook\s+\w+/.exec(h?.command ?? '');
    const path = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, homedir());
    return path.endsWith('copilot-mem.mjs') && existsSync(path);
  });
}

// Plugin installs can't run a setup step themselves: this pulls the model and runs the checks.
function setup() {
  const r = spawnSync('bash', [join(dirname(SELF), 'setup.sh')], { stdio: 'inherit', env: { ...process.env, SKIP_INSTALL: '1' } });
  process.exit(r.status ?? 1);
}

function install() {
  writeSettings(withHooks(readSettings(), SELF));
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  if (!existsSync(join(DATA, 'config.env'))) writeFileSync(join(DATA, 'config.env'), CONFIG_TEMPLATE, { mode: 0o600 });
  console.log(`hooks -> ${COPILOT_SETTINGS}\ndata  -> ${DATA}`);
}

function uninstall() {
  if (!existsSync(COPILOT_SETTINGS)) return console.log(`no ${COPILOT_SETTINGS}; nothing to remove`);
  const settings = readSettings();
  for (const ev of Object.keys(settings.hooks ?? {})) {
    const kept = settings.hooks[ev].filter((g) => !ours(g));
    if (kept.length === settings.hooks[ev].length) continue;
    if (kept.length) settings.hooks[ev] = kept;
    else delete settings.hooks[ev];
  }
  writeSettings(settings);
  console.log(`hooks removed from ${COPILOT_SETTINGS} (data kept in ${DATA})`);
}

async function doctor() {
  process.env.NO_PROXY = process.env.no_proxy = '*'; // every check here targets loopback
  const cfg = readConfig();
  const ok = (good, msg) => (console.log(`${good ? 'ok  ' : 'FAIL'} ${msg}`), good);
  let pass = true;
  let db = null, dbErr = '';
  try { db = await openDb(); } catch (e) { dbErr = e.message; }
  pass = ok(!!db, db ? `database ${DB_FILE}` : `database ${DB_FILE}: ${dbErr} (needs Node 22.16+ or 24+ for built-in SQLite with full-text search; this is ${process.version})`) && pass;
  let base = null;
  try { base = modelBase(cfg); } catch (e) { pass = ok(false, e.message) && pass; }
  if (base) {
    const model = cfg.COPILOT_MEM_OPENAI_COMPAT_MODEL;
    const models = await fetch(`${base}/models`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    pass = ok(!!models, `model server reachable at ${base}`) && pass;
    const has = !!models?.data?.some((m) => modelKey(m.id) === modelKey(model));
    const cloud = await cloudModel(base, model);
    if (cloud) {
      pass = ok(false, `note-writing model ${model} is a cloud model; choose one that runs on this machine`) && pass;
    } else {
      pass = ok(has, has ? `note-writing model ${model} available` : `note-writing model ${model} missing (ollama pull ${model})`) && pass;
      if (has && cloud === false) ok(true, `note-writing model ${model} runs on this machine`);
      else if (has) console.log(`info can't tell where ${model} runs; make sure ${base} doesn't forward to a remote API`);
    }
    if (process.platform === 'darwin') {
      // The sandbox must block the internet but allow loopback. Exit 2 = refused by the sandbox.
      const probe = (url) => {
        const [cmd, args] = sandboxed(process.execPath, ['-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),(e)=>process.exit(e.cause?.code==='EPERM'?2:1))`]);
        return spawnSync(cmd, args).status;
      };
      const net = probe('https://1.1.1.1');
      if (net === 1) console.log('info could not test the internet block (no internet connection?)');
      else pass = ok(net === 2, 'sandbox blocks the internet') && pass;
      pass = ok(probe(`${base}/models`) === 0, 'sandbox allows loopback') && pass;
    }
  }
  console.log(`info hooks ${settingsHasHooks() ? `in ${COPILOT_SETTINGS}` : `not in ${COPILOT_SETTINGS} (fine for a plugin install)`}`);
  if (db) {
    const n = (sql) => db.prepare(sql).get().n;
    console.log(`info ${n('SELECT count(*) n FROM observations')} notes, ${n('SELECT count(*) n FROM summaries')} summaries, ${n('SELECT count(*) n FROM prompts')} prompts`);
    console.log(`info turns: ${n("SELECT count(*) n FROM turns WHERE status = 'pending'")} waiting for the writer, ${n("SELECT count(*) n FROM turns WHERE status = 'failed'")} failed`);
    const last = db.prepare("SELECT error FROM turns WHERE status != 'done' AND error IS NOT NULL ORDER BY id DESC LIMIT 1").get();
    if (last) console.log(`info last writer error: ${last.error}`);
  }
  process.exit(pass ? 0 : 1);
}

// ---- self-test --------------------------------------------------------------------

async function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  const dir = mkdtempSync(join(tmpdir(), 'copilot-mem-selftest-'));
  const quiet = () => {};
  try {
    // Copilot transcript: the reply is the last message after the latest user message that calls no tools.
    const f = join(dir, 'events.jsonl');
    const ev = (type, content, toolRequests) => JSON.stringify({ type, data: { content, toolRequests } });
    writeFileSync(f, [ev('user.message', 'q1'), ev('assistant.message', 'first'), 'not json', ev('assistant.message', 'second'), ev('assistant.message', '')].join('\n'));
    assert(lastAssistantMessage(f) === 'second', 'reply read from transcript');
    writeFileSync(f, [ev('user.message', 'q1'), ev('assistant.message', 'old'), ev('user.message', 'q2')].join('\n'));
    assert(lastAssistantMessage(f) === '', 'stale turn ignored');
    writeFileSync(f, [ev('user.message', 'q'), ev('assistant.message', 'Let me check.', [{}])].join('\n'));
    assert(lastAssistantMessage(f) === '', 'a tool-calling step is not the reply');

    assert(toolEvent({ error: 'boom' }, true).output.includes('boom'), 'failure payload');
    // Anything that could send a turn off the machine is refused, as a config problem (turns wait).
    for (const url of ['https://api.openai.com/v1', '127.0.0.1:11434/v1', 'http://127.0.0.1.nip.io/v1', 'http://127.0.0.1@evil.example/v1', '']) {
      let e = null;
      try { modelBase({ COPILOT_MEM_OPENAI_COMPAT_BASE_URL: url }); } catch (x) { e = x; }
      assert(e?.unavailable, `model URL "${url}" refused`);
    }
    let leak = null;
    try { modelBase({ COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'http://user:s3cret@10.0.0.1/v1?key=s3cret' }); } catch (x) { leak = x; }
    assert(leak?.unavailable && !leak.message.includes('s3cret'), 'a refused URL is never echoed');
    assert(modelBase({ COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'http://u:p@127.0.0.1:11434/v1/?x=1' }) === 'http://127.0.0.1:11434/v1', 'credentials and query dropped');
    const cloud = await chat({ ...DEFAULTS, COPILOT_MEM_OPENAI_COMPAT_MODEL: 'gpt-oss:120b-cloud' }, 's', 'u').catch((e) => e);
    assert(cloud?.unavailable, 'cloud model refused');
    const sse = sseText('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata:{"choices":[{"delta":{"content":"b"}}]}\n\n: keep-alive\ndata:[DONE]\n');
    assert(sse.openai && sse.text === 'ab', 'streamed replies read, [DONE] in either form');

    // Settings: other settings and look-alike hooks survive; comments are understood.
    const s = withHooks(withHooks({ theme: 'x', hooks: { Stop: [{ hooks: [{ command: '~/bin/copilot-memo-sync.sh' }] }] } }, '/p/copilot-mem.mjs'), '/p/copilot-mem.mjs');
    assert(s.theme === 'x' && s.hooks.Stop.length === 2 && s.hooks.PostToolUse.length === 1, 'install keeps other settings and hooks, idempotent');
    const sf = join(dir, 'settings.json');
    writeFileSync(sf, `{\n  // mine\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "node \\"${SELF}\\" hook Stop"}]}]}\n}`);
    assert(settingsHasHooks(sf), 'settings hooks found despite comments');
    writeFileSync(sf, `{\n  "hooks": {\n    // "Stop": [{"hooks": [{"command": "node \\"${SELF}\\" hook Stop"}]}]\n  }\n}`);
    assert(!settingsHasHooks(sf), 'commented-out hooks ignored');

    // Projects: a linked worktree, or a bare-repo layout, belongs to its main repository, but only
    // when git's own entry points back at it; repositories with the same origin share memory.
    mkdirSync(join(dir, 'repo', '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(dir, 'wt'));
    writeFileSync(join(dir, 'wt', '.git'), `gitdir: ${join(dir, 'repo', '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(dir, 'repo', '.git', 'worktrees', 'wt', 'gitdir'), `${join(dir, 'wt', '.git')}\n`);
    mkdirSync(join(dir, 'b', '.bare', 'worktrees', 'main'), { recursive: true });
    mkdirSync(join(dir, 'b', 'main', 'src'), { recursive: true });
    writeFileSync(join(dir, 'b', 'main', '.git'), 'gitdir: ../.bare/worktrees/main\n');
    writeFileSync(join(dir, 'b', '.bare', 'worktrees', 'main', 'gitdir'), `${join(dir, 'b', 'main', '.git')}\n`);
    writeFileSync(join(dir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(dir, 'planted'));
    writeFileSync(join(dir, 'planted', '.git'), `gitdir: ${join(dir, 'repo', '.git', 'worktrees', 'wt')}\n`);
    mkdirSync(join(dir, 'planted2'));
    writeFileSync(join(dir, 'planted2', '.git'), `gitdir: ${join(dir, 'repo', '.git')}\n`);
    assert(projectOf(join(dir, 'wt')).root === join(dir, 'repo') && projectOf(join(dir, 'b', 'main', 'src')).name === 'b', 'worktrees belong to their repository');
    assert(projectOf(join(dir, 'planted')).root === join(dir, 'planted') && projectOf(join(dir, 'planted2')).root === join(dir, 'planted2'), 'git dir claims git did not write are ignored');
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core]\n\tbare = false\n[Remote "origin"]\n\tURL = git@github.com:Acme/App.git\n');
    mkdirSync(join(dir, 'clone', '.git'), { recursive: true });
    writeFileSync(join(dir, 'clone', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'clone', '.git', 'config'), '[remote "origin"]\n\turl = https://user@github.com/acme/app\n');
    assert(projectOf(join(dir, 'clone')).root === 'origin:github.com/acme/app' && projectOf(join(dir, 'wt')).root === 'origin:github.com/acme/app', 'clones and worktrees of one remote share memory');
    assert(['git@github.com:18F/App.git', 'https://u@github.com:443/18f/app/', 'ssh://git@github.com:22/18F/app.git', '"https://github.com/18F/app.git" ; mirror']
      .every((u) => originKey(u) === 'github.com/18f/app'), 'every spelling of one origin agrees');

    // Odd model replies are flattened, not lost; only a leading <think> block is dropped.
    const odd = parseNotes('<think>{maybe}</think> {"observations": {"type": "bugfix", "title": {"text": "Fixed\\nthe race"}}, "summary": "done"}');
    assert(odd.observations[0]?.title === 'Fixed the race' && odd.summary?.completed === 'done', 'odd model replies flattened');
    assert(parseNotes('{"observations": [{"title": "Strip <think>...</think> blocks"}]}').observations[0]?.title === 'Strip <think>...</think> blocks', 'think tags inside the JSON kept');

    // A whole session on a throwaway database, with a stand-in for the model.
    const db = await openDb(join(dir, 'memory.db'));
    const cfg = { ...DEFAULTS }, at = { session_id: 's1', cwd: dir }, noKick = () => {};
    const turns = () => db.prepare('SELECT count(*) n FROM turns').get().n;
    let kicked = 0;
    await handle(db, 'UserPromptSubmit', { ...at, prompt: 'fix the login bug' }, cfg, noKick);
    await handle(db, 'PostToolUse', { ...at, tool_name: 'edit', tool_input: { path: join(dir, 'auth.js') }, tool_result: { text_result_for_llm: 'ok' } }, cfg, noKick);
    await handle(db, 'PostToolUse', { ...at, tool_name: 'report_intent', tool_input: {} }, cfg, noKick);
    await handle(db, 'PostToolUse', { ...at, tool_name: 'Bash', tool_input: { command: `node "${SELF}" search "x"` } }, cfg, noKick);
    await handle(db, 'Stop', { ...at, last_assistant_message: 'Fixed it.' }, cfg, () => kicked++);
    const calls = db.prepare('SELECT data FROM events WHERE turn_id = 1').all().filter((r) => !JSON.parse(r.data).recall).length;
    assert(kicked === 1 && calls === 1, 'turn closed; skipped tools and memory lookups left out');
    const reply = JSON.stringify({
      observations: [{ type: 'bugfix', title: 'Fixed token refresh race', narrative: 'Refresh raced with logout.', facts: ['auth.js refreshes tokens'] }],
      summary: { request: 'fix the login bug', completed: 'fixed the refresh race' },
    });
    const seen = [];
    assert(await drain(db, async (sys, user) => (seen.push(user), '```json\n' + reply + '\n```'), quiet) === 'done', 'writer drains the queue');
    assert(seen[0].includes('fix the login bug') && seen[0].includes('edit {"path":"auth.js"}') && seen[0].includes('Fixed it.'), 'writer sees the whole turn');
    await writeTurn(db, db.prepare('SELECT * FROM turns WHERE id = 1').get(), async () => reply); // a second writer, same turn
    assert(db.prepare('SELECT count(*) n FROM observations').get().n === 1, 'a turn is saved only once');
    const ctx = (await handle(db, 'SessionStart', at, cfg, noKick)).additionalContext;
    assert(ctx.includes('[bugfix] Fixed token refresh race') && ctx.includes('Last summary') && ctx.includes(' search "<query>"'), 'session context');
    assert(search(db, 'refresh race').some((e) => e.key === '#1') && search(db, 'login', { type: 'prompts' })[0]?.key === 'P1', 'search');
    assert(byKey(db, '#1').body.includes('files modified: auth.js') && byKey(db, 'S1').body.includes('Completed: fixed'), 'get');
    assert(timeline(db, '#1').includes('→ #1'), 'timeline');
    const id = save(db, 'we use sqlite because it is built in', { title: 'db choice', project: basename(dir) });
    assert(search(db, 'sqlite')[0]?.key === `#${id}`, 'save');

    // Model down or misconfigured: the turn waits and the next session hears about it.
    // Unusable replies: retried, then dropped.
    await handle(db, 'PostToolUse', { ...at, tool_name: 'bash', tool_input: { command: 'npm test' }, tool_result: { text_result_for_llm: 'ok' } }, cfg, noKick);
    await handle(db, 'Stop', { ...at, last_assistant_message: 'Tests pass.' }, cfg, noKick);
    const down = async () => { throw unavailable('down'); };
    assert(await drain(db, down, quiet) === 'unavailable' && pendingTurns(db) === 1, 'model down: turn kept');
    assert((await handle(db, 'SessionStart', at, cfg, noKick)).additionalContext.includes('could not save yet'), 'stuck turns surfaced');
    const remote = (sys, user) => chat({ ...cfg, COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'http://10.1.2.3/v1' }, sys, user);
    assert(await drain(db, remote, quiet) === 'unavailable' && pendingTurns(db) === 1, 'remote model URL: nothing sent, turn kept');
    for (let i = 1; i <= 3; i++) { // one try per run, never back to back
      await drain(db, async () => 'no json here', quiet);
      assert(db.prepare('SELECT attempts FROM turns WHERE id = 2').get().attempts === i, `bad reply counted once in run ${i}`);
    }
    assert(db.prepare('SELECT status FROM turns WHERE id = 2').get().status === 'failed', 'bad replies dropped after 3 tries');

    // An interrupted turn keeps its own prompt; a turn that only used memory adds nothing.
    await handle(db, 'UserPromptSubmit', { ...at, prompt: 'delete the build folder' }, cfg, noKick);
    await handle(db, 'PostToolUse', { ...at, tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_result: { text_result_for_llm: '' } }, cfg, noKick);
    await handle(db, 'UserPromptSubmit', { ...at, prompt: 'what did we do about the login bug?' }, cfg, noKick);
    assert(db.prepare('SELECT prompt FROM turns ORDER BY id DESC LIMIT 1').get().prompt === 'delete the build folder', 'interrupted turn keeps its own prompt');
    const before = turns();
    await handle(db, 'PostToolUse', { ...at, tool_name: 'Bash', tool_input: { command: `node "${SELF}" get 1` } }, cfg, noKick);
    await handle(db, 'Stop', { ...at, last_assistant_message: 'We fixed the refresh race.' }, cfg, noKick);
    await handle(db, 'SessionEnd', at, cfg, noKick);
    assert(turns() === before, 'memory-only turn and an empty session end add no turn');
    await handle(db, 'PostToolUse', { ...at, tool_name: 'Bash', tool_input: { command: `node "${SELF}" search "helm"` }, tool_result: { text_result_for_llm: 'no matches\n<shellId: 0 completed with exit code 0>' } }, cfg, noKick);
    await handle(db, 'Stop', { ...at, last_assistant_message: 'Nothing on record, so we will deploy with Helm.' }, cfg, noKick);
    assert(turns() === before + 1, 'a memory lookup that found nothing keeps the turn');

    // Re-filing: a moved repository without a remote takes its notes along (once, then they are
    // its own); a repository with a remote doesn't pick up a vanished folder's notes; notes
    // filed under a folder follow it when it gains a remote.
    const note = (project, root, title) => db.prepare(`INSERT INTO observations
      (project, root, type, title, narrative, facts, files_read, files_modified, created_at) VALUES (?, ?, 'note', ?, '', '[]', '[]', '[]', ?)`).run(project, root, title, now());
    note('app', join(dir, 'gone', 'app'), 'moved note');
    mkdirSync(join(dir, 'other', 'app'), { recursive: true });
    note('app', join(dir, 'other', 'app'), 'other repo note');
    const movedTo = { name: 'app', root: join(dir, 'new', 'app'), path: join(dir, 'new', 'app') };
    adopt(db, movedTo);
    const moved = sessionContext(db, movedTo, cfg);
    assert(moved.includes('moved note') && !moved.includes('other repo note'), 'a moved repository keeps its memory');
    note('app', join(dir, 'gone2', 'app'), 'deleted note');
    const withRemote = { name: 'app', root: 'origin:example.com/x/app', path: join(dir, 'third', 'app') };
    adopt(db, withRemote);
    assert(!sessionContext(db, withRemote, cfg).includes('deleted note'), 'a repository with a remote ignores vanished folders');
    note('pathrepo', join(dir, 'pathrepo'), 'path note');
    const gained = { name: 'pathrepo', root: 'origin:example.com/x/pathrepo', path: join(dir, 'pathrepo') };
    adopt(db, gained);
    assert(sessionContext(db, gained, cfg).includes('path note'), 'notes follow a repository that gained a remote');
    db.close();

    // Rows from before roots were recorded get one from their session's folder on upgrade.
    const old = await openDb(join(dir, 'old.db'));
    old.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s9', 'wt', ?, ?)").run(join(dir, 'wt'), now());
    old.prepare("INSERT INTO observations (session_id, project, type, title, narrative, facts, files_read, files_modified, created_at) VALUES ('s9', 'wt', 'note', 'x', '', '[]', '[]', '[]', ?)").run(now());
    old.exec('PRAGMA user_version = 1');
    old.close();
    const upgraded = await openDb(join(dir, 'old.db'));
    assert(upgraded.prepare('SELECT root FROM observations').get().root === 'origin:github.com/acme/app', 'old rows get their repository on upgrade');
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('selftest ok');
}

// ---- main -------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'hook': await hook(rest[0]); break;
    case 'search': case 'timeline': case 'get': case 'save': await memoryCommand(cmd, rest); break;
    case 'writer': await writer().catch((e) => log(`writer: ${e.stack ?? e.message}`)); break;
    case 'config': console.log(readConfig()[rest[0]] ?? ''); break; // effective setting, for setup.sh
    case 'viewer': await viewer(); break;
    case 'setup': setup(); break;
    case 'install': install(); break;
    case 'uninstall': uninstall(); break;
    case 'doctor': await doctor(); break;
    case 'selftest': await selftest(); break;
    default:
      console.log('usage: copilot-mem setup | install | uninstall | doctor | selftest | viewer\n       copilot-mem search "<query>" | timeline <ID> | get <ID>... | save "<note>"');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
