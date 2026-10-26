#!/usr/bin/env node
// Rename claude-mem -> copilot-mem (every casing/separator) across engine/,
// file names included, apply the GitHub/Copilot look (theme/), then rebuild
// the runtime in engine/plugin.
// Re-run after `git -C engine pull` (or a fresh clone) to update.
//
//   node rebrand-engine.mjs [--no-build]

import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = resolve(process.env.COPILOT_MEM_ENGINE_DIR || join(dirname(fileURLToPath(import.meta.url)), 'engine'));
const SKIP = new Set(['.git', 'node_modules']);
const CASE = { claude: 'copilot', Claude: 'Copilot', CLAUDE: 'COPILOT' };
const RE = /(claude|Claude|CLAUDE)([-_ ]?)(mem|Mem|MEM)/g;

export const rebrand = (s) => s.replace(RE, (_, c, sep, m) => CASE[c] + sep + m);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p, out);
    out.push(p); // children before parent, so renames never invalidate paths
  }
  return out;
}

function run() {
  let files = 0, renamed = 0;
  for (const p of walk(ENGINE)) {
    if (statSync(p).isFile()) {
      const buf = readFileSync(p);
      if (!buf.includes(0)) { // text only
        const s = buf.toString('utf8');
        const t = rebrand(s);
        if (t !== s) { writeFileSync(p, t); files++; }
      }
    }
    const base = p.slice(p.lastIndexOf('/') + 1);
    const nb = rebrand(base);
    if (nb !== base) { renameSync(p, join(dirname(p), nb)); renamed++; }
  }
  console.log(`rewrote ${files} files, renamed ${renamed} paths`);
}

// ---- GitHub / Copilot look ---------------------------------------------------

const THEME = join(dirname(fileURLToPath(import.meta.url)), 'theme');
const UI_SRC = join(ENGINE, 'src', 'ui', 'viewer');
const UI_OUT = join(ENGINE, 'plugin', 'ui');

// Patch `file`: each [from, to, applied] must match, or `applied` (a string in
// the patched file, or a function of it) must say it's already done, so an
// upstream change that moves the code fails loudly instead of silently.
function patch(file, edits) {
  let s = readFileSync(file, 'utf8');
  for (const [from, to, applied] of edits) {
    if (typeof from === 'string' ? s.includes(from) : from.test(s)) s = s.replace(from, to);
    else if (!(typeof applied === 'function' ? applied(s) : s.includes(applied))) throw new Error(`theme patch target not found in ${file}: ${from}`);
  }
  writeFileSync(file, s);
}

function patchSources() {
  const paths = [...readFileSync(join(THEME, 'copilot.svg'), 'utf8').matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]);
  const logo = `<svg className={\`logomark $1\`} viewBox="0 0 24 24" width="32" height="32" fill="currentColor" aria-label="GitHub Copilot">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
  patch(join(UI_SRC, 'components', 'Header.tsx'), [
    [/<img src="copilot-mem-logomark\.webp" alt="" className=\{`logomark ([^`]*)`\} \/>/, logo, 'aria-label="GitHub Copilot"'],
    // fetches api.github.com on every page load
    [/\s*<GitHubStarsButton [^>]*\/>/, '', (s) => !s.includes('<GitHubStarsButton')],
    ["import { GitHubStarsButton } from './GitHubStarsButton';\n", '', (s) => !s.includes('GitHubStarsButton')],
  ]);
  patch(join(UI_SRC, 'hooks', 'useSpinningFavicon.ts'), [["'copilot-mem-logomark.webp'", "'copilot.svg'", "'copilot.svg'"]]);
  patch(join(UI_SRC, 'components', 'WelcomeCard.tsx'), [['"copilot-mem-logo-stylized.png"', '"copilot.svg"', '"copilot.svg"']]);
}

// The browser isn't inside the network sandbox, so the pages get a CSP that
// lets them talk to the local worker only.
const CSP = `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'self'">`;
const MARK = ['<!--copilot-mem-theme-->', '<!--/copilot-mem-theme-->'];

function themeBuilt() {
  const css = readFileSync(join(THEME, 'github.css'), 'utf8');
  copyFileSync(join(THEME, 'copilot.svg'), join(UI_OUT, 'copilot.svg'));
  copyFileSync(join(THEME, 'copilot.svg'), join(UI_OUT, 'work-view', 'favicon.svg'));
  for (const page of ['viewer.html', 'tv.html', join('work-view', 'index.html')]) {
    const file = join(UI_OUT, page);
    let s = readFileSync(file, 'utf8').replace(new RegExp(`${MARK[0]}[\\s\\S]*?${MARK[1]}`, 'g'), '');
    s = s.replace(/<head>/i, `<head>${MARK[0]}${CSP}${MARK[1]}`)
      .replace(/<\/head>/i, `${MARK[0]}<style>${css}</style>${MARK[1]}</head>`)
      .replace(/<link rel="icon" type="image\/webp" href="copilot-mem-logomark\.webp">/, '<link rel="icon" type="image/svg+xml" href="copilot.svg">');
    writeFileSync(file, s);
  }
  console.log('applied GitHub theme to plugin/ui');
}

if (process.argv[2] === 'selftest') {
  const cases = [['CLAUDE_MEM_PORT', 'COPILOT_MEM_PORT'], ['~/.claude-mem/claude-mem.db', '~/.copilot-mem/copilot-mem.db'],
    ['ClaudeMemPlugin', 'CopilotMemPlugin'], ['claude_mem_37701', 'copilot_mem_37701'], ['Claude Code', 'Claude Code'], ['claudemem', 'copilotmem']];
  for (const [a, b] of cases) if (rebrand(a) !== b) { console.error(`FAIL ${a} -> ${rebrand(a)}`); process.exit(1); }
  console.log('selftest ok');
} else {
  run();
  patchSources();
  if (!process.argv.includes('--no-build')) execFileSync('node', ['scripts/build-hooks.js'], { cwd: ENGINE, stdio: 'inherit' });
  themeBuilt();
}
