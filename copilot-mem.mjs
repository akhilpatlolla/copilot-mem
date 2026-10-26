#!/usr/bin/env node
// copilot-mem: persistent memory for GitHub Copilot CLI, 100% local.
//
// Copilot runs this from hooks in ~/.copilot/settings.json (no plugin, no MCP).
// It is a thin front-end over the vendored memory engine (./engine/plugin):
//   1. pins every privacy-relevant engine setting via env (env beats settings.json),
//   2. runs the engine under a macOS sandbox that only allows loopback network,
//   3. adapts Copilot hook payloads (events.jsonl transcript -> last message),
//   4. rebrands engine output and strips guidance for tools that don't exist here.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DATA = process.env.COPILOT_MEM_DATA_DIR || join(homedir(), '.copilot-mem');
// Engine: next to this script (git clone + ./setup.sh), else in the data dir
// (plugin install + `copilot-mem.mjs setup`).
const ENGINE = process.env.COPILOT_MEM_ENGINE
  || [join(dirname(SELF), 'engine', 'plugin'), join(DATA, 'engine', 'plugin')].find((d) => existsSync(join(d, 'scripts', 'worker-service.cjs')))
  || join(DATA, 'engine', 'plugin');
const WORKER = join(ENGINE, 'scripts', 'worker-service.cjs');
const COPILOT_SETTINGS = join(homedir(), '.copilot', 'settings.json');

// ---- config -----------------------------------------------------------------

// Engine settings, lowest to highest precedence: these defaults, then
// ~/.copilot-mem/config.env, then the process env, then LOCKED (always wins).
const DEFAULTS = {
  COPILOT_MEM_WORKER_PORT: '37702',
  COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
  COPILOT_MEM_OPENAI_COMPAT_MODEL: 'qwen2.5-coder:7b',
  COPILOT_MEM_CHROMA_ENABLED: 'true',
  COPILOT_MEM_CONTEXT_OBSERVATIONS: '50',
  COPILOT_MEM_SKIP_TOOLS: 'report_intent,task_complete,think,TodoWrite,AskUserQuestion,Skill',
  COPILOT_MEM_LOG_LEVEL: 'INFO',
};

// Privacy- and isolation-critical: never user-overridable.
const LOCKED = {
  COPILOT_MEM_DATA_DIR: DATA,
  COPILOT_MEM_WORKER_HOST: '127.0.0.1',
  COPILOT_MEM_RUNTIME: 'worker',
  // observer = local Ollama, no fallback to any hosted provider
  COPILOT_MEM_PROVIDER: 'openai-compatible',
  COPILOT_MEM_OPENAI_COMPAT_PRESET: 'ollama',
  COPILOT_MEM_OPENAI_COMPAT_API_KEY: 'ollama',
  COPILOT_MEM_QUOTA_FALLBACK_PROVIDER: 'off',
  COPILOT_MEM_TIER_ROUTING_ENABLED: 'false',
  // every outbound feature off
  COPILOT_MEM_TELEGRAM_ENABLED: 'false',
  COPILOT_MEM_TRANSCRIPTS_ENABLED: 'false',
  COPILOT_MEM_WELCOME_HINT_ENABLED: 'false',
  COPILOT_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  COPILOT_MEM_CAPTURE_ADVISOR_CALLS: 'false',
  COPILOT_MEM_WORK_VIEW_AUTO_REFRESH: 'false', // would spawn codex/claude CLIs (cloud)
  COPILOT_MEM_CHROMA_MODE: 'local',
  COPILOT_MEM_CHROMA_HOST: '127.0.0.1',
  COPILOT_MEM_TELEMETRY_HOST: 'http://127.0.0.1:9',
  CMEM_PRO_ORIGIN: 'http://127.0.0.1:9',
  DO_NOT_TRACK: '1',
  ANONYMIZED_TELEMETRY: 'False',
  UV_OFFLINE: '1',
  HF_HUB_OFFLINE: '1',
};

export function readConfig() {
  const cfg = { ...DEFAULTS };
  try {
    for (const line of readFileSync(join(DATA, 'config.env'), 'utf8').split('\n')) {
      const m = /^\s*(COPILOT_MEM_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('COPILOT_MEM_')) cfg[k] = v;
  return cfg;
}

// Loopback-only URLs: the observer model must never be remote.
function assertLoopback(url) {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`COPILOT_MEM_OPENAI_COMPAT_BASE_URL must be loopback, got ${host}`);
  }
}

export function engineEnv(cfg = readConfig()) {
  assertLoopback(cfg.COPILOT_MEM_OPENAI_COMPAT_BASE_URL);
  const env = { ...process.env };
  // Never hand cloud credentials to the engine.
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|GOOGLE_API)/.test(k)) delete env[k];
  return {
    ...env, ...cfg, ...LOCKED,
    CLAUDE_CONFIG_DIR: join(DATA, 'host'), // keep the engine out of ~/.claude
    CLAUDE_PLUGIN_ROOT: ENGINE,
  };
}

// ---- sandbox ----------------------------------------------------------------

// Other agents' data. The engine's prompt importer reads these straight from
// $HOME, so they're blocked at the OS level rather than by settings.
export const PRIVATE_DIRS = ['.claude', '.claude-mem', '.codex', '.gemini', '.cursor', '.local/share/opencode']
  .map((d) => join(homedir(), d));

// Seatbelt profile: everything allowed except (1) outbound network to anything
// but loopback, DNS included so hostnames can't leak, and (2) any access to
// other agents' data directories.
export const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(deny file-read* file-write* ${PRIVATE_DIRS.map((d) => `(subpath ${JSON.stringify(d)})`).join(' ')})`;

function sandboxed(cmd, args) {
  if (process.platform !== 'darwin') return [cmd, args]; // ponytail: macOS only; use a netns/firewall elsewhere
  return ['/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, cmd, ...args]];
}

function bunPath() {
  for (const p of [process.env.BUN, join(homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
    if (p && existsSync(p)) return p;
  }
  return 'bun';
}

function runEngine(args, { input, env = engineEnv(), timeoutMs = 120_000 } = {}) {
  const [cmd, argv] = sandboxed(bunPath(), [WORKER, ...args]);
  const r = spawnSync(cmd, argv, {
    input, env: { ...env, COPILOT_MEM_HOOK_ORIGINAL_CWD: process.cwd() },
    cwd: tmpdir(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- rebranding ---------------------------------------------------------------

export function rebrand(text) {
  return text
    .split('\n')
    .filter((l) => !/cmem\.ai|Free Trial|CMEM Pro|\bPro\b.*trial/i.test(l))
    .join('\n')
    // guidance for the hidden cloud-only tools
    .replace(/ For server notes, use observation_add[^.]*\.[^.]*\./g, '')
    .replace(/ A hosted read-only connector[^.]*\./g, '')
    .replace(/ Never assume a hosted memory search[^.]*\./g, '')
    .replace(/e\.g\. claude, codex, cursor/g, 'e.g. copilot')
    .replace(/Claude Code/g, 'Copilot')
    .replace(/\bClaude's\b/g, "Copilot's");
}

// ---- hooks --------------------------------------------------------------------

// Copilot event (Claude-format name) -> engine handler.
const HOOK_EVENTS = {
  SessionStart: 'context',
  UserPromptSubmit: 'session-init',
  PostToolUse: 'observation',
  PostToolUseFailure: 'observation',
  Stop: 'summarize',
  SubagentStop: 'subagent-stop',
  SessionEnd: 'session-end',
};

// Copilot's transcript is ~/.copilot/session-state/<id>/events.jsonl, not a
// Claude JSONL; pull this turn's last assistant message out of it ourselves.
// Only a message after the latest user.message counts (else it's last turn's).
export function lastAssistantMessage(transcriptPath) {
  let last = '';
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'user.message') last = '';
        else if (e.type === 'assistant.message' && typeof e.data?.content === 'string' && e.data.content.trim()) last = e.data.content;
      } catch {}
    }
  } catch {}
  return last;
}

// Copilot fires Stop a few ms before it flushes the final message to disk.
async function awaitAssistantMessage(transcriptPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const msg = lastAssistantMessage(transcriptPath);
    if (msg || Date.now() > deadline) return msg;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function adaptPayload(event, p) {
  const out = { ...p };
  if (event === 'Stop' || event === 'SubagentStop') {
    if (out.transcript_path) out.last_assistant_message = await awaitAssistantMessage(out.transcript_path);
    if (!out.last_assistant_message) log(`${event}: no assistant message in ${out.transcript_path}`);
    delete out.transcript_path; // engine would parse it as a Claude transcript
  }
  if (event === 'PostToolUseFailure' && out.tool_response === undefined) {
    out.tool_response = { error: out.error ?? out.tool_error ?? 'tool failed' };
  }
  return out;
}

// The engine's context tells the model to call MCP tools; there are none here.
// Drop that guidance and point at the shell commands instead (no MCP needed,
// so org MCP policies don't matter).
export function memoryContext(ctx) {
  const kept = ctx
    .split(/\n(?=# )/)
    .filter((s) => !/^# (Work state|copilot-mem memory use)/.test(s))
    .join('\n')
    .split('\n')
    .filter((l) => !/^Fetch details:|^Access .* via get_observations/.test(l))
    .join('\n')
    .trim();
  const cli = `node "${SELF}"`;
  return `${kept}

# Memory search (copilot-mem)
Past work from earlier sessions is stored locally. When you need more than the list above, run these shell commands:
- ${cli} search "<query>" [--project <name>] [--type observations|sessions|prompts] [--limit N]   (index with IDs)
- ${cli} timeline <ID>   (what happened around an observation)
- ${cli} get <ID> [<ID>...]   (full details; only for IDs you picked)
- ${cli} save "<note>" [--title <title>]   (record a decision, preference or lesson for future sessions)
Search first, then fetch only the IDs you need.`;
}

// Copilot reads a top-level `additionalContext`; it ignores Claude's
// `hookSpecificOutput` wrapper (verified against Copilot CLI 1.0.103).
export function hookOutput(stdout, event) {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return {};
  let r;
  try { r = JSON.parse(line); } catch { return {}; }
  const out = {};
  let ctx = r.hookSpecificOutput?.additionalContext;
  if (ctx && event === 'SessionStart') ctx = memoryContext(ctx);
  if (ctx) out.additionalContext = rebrand(ctx);
  if (r.systemMessage) out.systemMessage = rebrand(r.systemMessage);
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function hook(event) {
  // Memory must never break the agent: every path exits 0 with valid JSON.
  try {
    const engineEvent = HOOK_EVENTS[event];
    if (!engineEvent) return print({});
    // Installed both as a plugin and via settings.json: let settings.json win.
    if (process.env.COPILOT_PLUGIN_ROOT && settingsHasHooks()) return print({});
    if (!existsSync(WORKER)) {
      return print(event === 'SessionStart'
        ? { additionalContext: `copilot-mem is installed but not set up yet, so nothing is being remembered. Tell the user to run this once: node "${SELF}" setup` }
        : {});
    }
    const raw = await readStdin();
    const payload = await adaptPayload(event, JSON.parse(raw || '{}'));
    const env = engineEnv();
    if (event === 'SessionStart') runEngine(['start'], { env, timeoutMs: 60_000 });
    const r = runEngine(['hook', 'copilot', engineEvent], { input: JSON.stringify(payload), env });
    const out = hookOutput(r.stdout, event);
    if (env.COPILOT_MEM_LOG_LEVEL === 'DEBUG') log(`hook ${event} in=${raw.slice(0, 500)} engine=${r.stdout.slice(0, 300)} out=${JSON.stringify(out).slice(0, 300)}`);
    print(out);
  } catch (e) {
    log(`hook ${event}: ${e.message}`);
    print({});
  }
}

const print = (o) => process.stdout.write(JSON.stringify(o) + '\n');
function log(msg) {
  try { mkdirSync(join(DATA, 'logs'), { recursive: true }); writeFileSync(join(DATA, 'logs', 'copilot-mem.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' }); } catch {}
}

// ---- on-demand search (plain HTTP to the local worker, no MCP) -------------------

function parseArgs(args) {
  const opts = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { opts, pos };
}

async function worker(path, body) {
  const url = `http://127.0.0.1:${readConfig().COPILOT_MEM_WORKER_PORT}${path}`;
  let res;
  try {
    res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    runEngine(['start'], { timeoutMs: 60_000 }); // first use before any Copilot session
    res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  }
  if (!res.ok) throw new Error(`memory worker ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const text = (r) => rebrand((r.content ?? []).map((c) => c.text).join('\n'));

async function memoryCommand(cmd, args) {
  const { opts, pos } = parseArgs(args);
  const q = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));
  switch (cmd) {
    case 'search':
      if (!pos.length) throw new Error('usage: search "<query>" [--project p] [--type t] [--limit n]');
      return console.log(text(await worker('/api/search' + q({ query: pos.join(' '), project: opts.project, type: opts.type, limit: opts.limit ?? 20 }))));
    case 'timeline':
      if (!pos[0]) throw new Error('usage: timeline <ID>');
      return console.log(text(await worker('/api/timeline' + q({ anchor: pos[0].replace(/^#/, ''), depth_before: opts.before ?? 5, depth_after: opts.after ?? 5, project: opts.project }))));
    case 'get': {
      const ids = pos.map((s) => Number(s.replace(/^#/, ''))).filter(Number.isInteger);
      if (!ids.length) throw new Error('usage: get <ID> [<ID>...]');
      for (const o of await worker('/api/observations/batch', { ids })) {
        const list = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
        console.log(rebrand([
          `#${o.id} [${o.type}] ${o.title}`, o.subtitle, o.narrative,
          ...list(o.facts).map((f) => `- ${f}`),
          list(o.files_modified).length ? `files modified: ${list(o.files_modified).join(', ')}` : '',
          list(o.files_read).length ? `files read: ${list(o.files_read).join(', ')}` : '',
        ].filter(Boolean).join('\n')) + '\n');
      }
      return;
    }
    case 'save':
      if (!pos.length) throw new Error('usage: save "<note>" [--title t] [--project p]');
      await worker('/api/memory/save', { text: pos.join(' '), title: opts.title, project: opts.project });
      return console.log('saved');
  }
}

// ---- install / doctor -------------------------------------------------------------

// Hooks go straight into ~/.copilot/settings.json (Claude-format event names,
// which Copilot accepts). Other settings and other hooks are left untouched.
export function withHooks(settings, script) {
  const timeouts = { SessionStart: 90, UserPromptSubmit: 20, PostToolUse: 30, PostToolUseFailure: 30, Stop: 60, SubagentStop: 30, SessionEnd: 30 };
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [ev, timeout] of Object.entries(timeouts)) {
    const others = (hooks[ev] ?? []).filter((g) => !JSON.stringify(g).includes('copilot-mem'));
    hooks[ev] = [...others, { matcher: '*', hooks: [{ type: 'command', command: `node "${script}" hook ${ev}`, timeout }] }];
  }
  return { ...settings, hooks };
}

// Data files and setting keys still carrying the upstream name (pre-rename installs).
const OLD = /(claude|Claude|CLAUDE)([-_]?)(mem|Mem|MEM)/g;
const NEW = (_, c, sep, m) => ({ claude: 'copilot', Claude: 'Copilot', CLAUDE: 'COPILOT' })[c] + sep + m;
export function migrateData(dir = DATA) {
  for (const sub of ['', 'logs', 'backups']) {
    const d = join(dir, sub);
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      const nn = n.replace(OLD, NEW);
      if (nn !== n && !existsSync(join(d, nn))) renameSync(join(d, n), join(d, nn));
    }
  }
  const sp = join(dir, 'settings.json');
  try { const s = readFileSync(sp, 'utf8'), t = s.replace(OLD, NEW); if (t !== s) writeFileSync(sp, t); } catch {}
}

function settingsHasHooks() {
  try { return JSON.stringify(JSON.parse(readFileSync(COPILOT_SETTINGS, 'utf8')).hooks ?? {}).includes('copilot-mem'); } catch { return false; }
}

// For plugin installs: build the engine into the data dir with setup.sh.
function setup() {
  const r = spawnSync('bash', [join(dirname(SELF), 'setup.sh')], {
    stdio: 'inherit', env: { ...process.env, COPILOT_MEM_ENGINE_DIR: join(DATA, 'engine'), SKIP_INSTALL: '1' },
  });
  process.exit(r.status ?? 1);
}

function install() {
  if (!existsSync(WORKER)) throw new Error(`engine not found at ${ENGINE}`);
  mkdirSync(join(DATA, 'host'), { recursive: true });
  migrateData();
  let settings = {};
  try { settings = JSON.parse(readFileSync(COPILOT_SETTINGS, 'utf8')); } catch {}
  mkdirSync(dirname(COPILOT_SETTINGS), { recursive: true });
  writeFileSync(COPILOT_SETTINGS, JSON.stringify(withHooks(settings, SELF), null, 2) + '\n');
  if (!existsSync(join(DATA, 'config.env'))) {
    writeFileSync(join(DATA, 'config.env'), [
      '# copilot-mem settings (all optional)',
      '# COPILOT_MEM_OPENAI_COMPAT_MODEL=qwen2.5-coder:7b          # local Ollama model that writes memories',
      '# COPILOT_MEM_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:11434/v1',
      '# COPILOT_MEM_WORKER_PORT=37702                             # worker + web viewer port',
      '# COPILOT_MEM_CHROMA_ENABLED=true                           # local Chroma vector search',
      '',
    ].join('\n'));
  }
  // Telemetry consent file: explicitly declined.
  writeFileSync(join(DATA, 'telemetry.json'), JSON.stringify({ enabled: false, decidedAt: new Date().toISOString() }));
  console.log(`hooks  -> ${COPILOT_SETTINGS}\nengine -> ${ENGINE}\ndata   -> ${DATA}`);
}

function uninstall() {
  let settings = {};
  try { settings = JSON.parse(readFileSync(COPILOT_SETTINGS, 'utf8')); } catch { return; }
  for (const ev of Object.keys(settings.hooks ?? {})) {
    settings.hooks[ev] = settings.hooks[ev].filter((g) => !JSON.stringify(g).includes('copilot-mem'));
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  writeFileSync(COPILOT_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`hooks removed from ${COPILOT_SETTINGS} (data kept in ${DATA})`);
}

async function doctor() {
  const cfg = readConfig();
  const ok = (b, msg) => { console.log(`${b ? 'ok  ' : 'FAIL'} ${msg}`); return b; };
  let all = ok(existsSync(WORKER), `engine at ${ENGINE}`);
  const models = await fetch(cfg.COPILOT_MEM_OPENAI_COMPAT_BASE_URL.replace(/\/v1\/?$/, '') + '/api/tags').then((r) => r.json()).catch(() => null);
  all &= ok(!!models, `ollama reachable at ${cfg.COPILOT_MEM_OPENAI_COMPAT_BASE_URL}`);
  all &= ok(!!models?.models?.some((m) => m.name === cfg.COPILOT_MEM_OPENAI_COMPAT_MODEL), `observer model ${cfg.COPILOT_MEM_OPENAI_COMPAT_MODEL} pulled`);
  // The sandbox must block the internet but allow loopback.
  const probe = (url) => {
    const [cmd, argv] = sandboxed(process.execPath, ['-e', `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0),()=>process.exit(1))`]);
    return spawnSync(cmd, argv).status === 0;
  };
  all &= ok(!probe('https://1.1.1.1'), 'sandbox blocks internet');
  all &= ok(probe(cfg.COPILOT_MEM_OPENAI_COMPAT_BASE_URL.replace(/\/v1\/?$/, '') + '/api/version'), 'sandbox allows loopback');
  const target = PRIVATE_DIRS.find((d) => existsSync(d));
  if (target) {
    const [cmd, argv] = sandboxed(process.execPath, ['-e', `require('fs').readdirSync(${JSON.stringify(target)})`]);
    all &= ok(spawnSync(cmd, argv).status !== 0, `sandbox blocks other agents' data (${target})`);
  }
  const health = await fetch(`http://127.0.0.1:${cfg.COPILOT_MEM_WORKER_PORT}/api/health`).then((r) => r.ok).catch(() => false);
  ok(health, `worker on 127.0.0.1:${cfg.COPILOT_MEM_WORKER_PORT} (starts on first Copilot session)`);
  process.exit(all ? 0 : 1);
}

// ---- self-test --------------------------------------------------------------------

async function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
  assert(!rebrand('a\n✨ 30 Day Free Trial https://cmem.ai/pro\nb').includes('cmem'), 'rebrand drops promo');
  const f = join(tmpdir(), `copilot-mem-selftest-${process.pid}.jsonl`);
  const ev = (type, content) => JSON.stringify({ type, data: { content } });
  writeFileSync(f, [ev('user.message', 'q1'), ev('assistant.message', 'first'), 'not json', ev('assistant.message', 'second'), ev('assistant.message', '')].join('\n'));
  const p = await adaptPayload('Stop', { session_id: 's', transcript_path: f });
  assert(p.last_assistant_message === 'second' && !p.transcript_path, 'stop payload');
  // New turn not yet flushed: must not return the previous turn's reply.
  writeFileSync(f, [ev('user.message', 'q1'), ev('assistant.message', 'old'), ev('user.message', 'q2')].join('\n'));
  assert(lastAssistantMessage(f) === '', 'stale turn ignored');
  unlinkSync(f);
  assert((await adaptPayload('PostToolUseFailure', { error: 'boom' })).tool_response.error === 'boom', 'failure payload');
  let threw = false; try { engineEnv({ ...readConfig(), COPILOT_MEM_OPENAI_COMPAT_BASE_URL: 'https://api.openai.com/v1' }); } catch { threw = true; }
  assert(threw, 'remote observer URL rejected');
  const ctx = memoryContext('# Work state\nuse work_state_write\n\n# [p] recent context\n1 1:35a ● Fixed bug\nFetch details: get_observations([IDs]) | Search: mem-search skill\n\n# copilot-mem memory use\nsave_memory(...)');
  assert(ctx.includes('Fixed bug') && ctx.includes(' search "<query>"') && !/work_state|get_observations|save_memory|mem-search skill/.test(ctx), 'context points at CLI, not MCP');
  const o = hookOutput('noise\n{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}', 'UserPromptSubmit');
  assert(o.additionalContext === 'ctx' && !o.hookSpecificOutput, 'top-level additionalContext');
  const s = withHooks(withHooks({ theme: 'x', hooks: { Stop: [{ hooks: [{ command: 'other' }] }] } }, '/p/copilot-mem.mjs'), '/p/copilot-mem.mjs');
  assert(s.theme === 'x' && s.hooks.Stop.length === 2 && s.hooks.PostToolUse.length === 1, 'install keeps other settings, idempotent');
  const env = engineEnv();
  assert(env.COPILOT_MEM_PROVIDER === 'openai-compatible' && env.COPILOT_MEM_QUOTA_FALLBACK_PROVIDER === 'off', 'provider locked');
  assert(engineEnv({ ...readConfig(), COPILOT_MEM_PROVIDER: 'claude' }).COPILOT_MEM_PROVIDER === 'openai-compatible', 'lock beats config');
  console.log('selftest ok');
}

// ---- main -------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'hook': await hook(rest[0]); break;
  case 'search': case 'timeline': case 'get': case 'save':
    try { await memoryCommand(cmd, rest); } catch (e) { console.error(e.message); process.exit(1); }
    break;
  case 'setup': setup(); break;
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'doctor': await doctor(); break;
  case 'selftest': await selftest(); break;
  case 'start': case 'stop': case 'restart': case 'status': {
    const r = runEngine([cmd]);
    process.stdout.write(rebrand(r.stdout)); process.stderr.write(rebrand(r.stderr)); process.exit(r.status ?? 1);
  }
  default:
    console.log('usage: copilot-mem setup | install | uninstall | doctor | selftest | start | stop | restart | status\n       copilot-mem search "<query>" | timeline <ID> | get <ID>... | save "<note>"');
}
