# ResumerAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web dashboard that lists dead/resumable and live Claude Code sessions across all working directories, and lets you reopen a terminal on any of them with one click.

**Architecture:** A single Node.js process (`server.mjs`, no framework) with small pure-logic modules under `lib/` (config resolution, registry reading, live-agent querying, transcript preview, merging, resume-command building), serving a static vanilla HTML/CSS/JS frontend under `public/`.

**Tech Stack:** Node.js 18+ (`node:http`, `node:fs`, `node:child_process`), pnpm via Corepack, no frontend framework/build step, vanilla CSS for the dark theme and motion.

**Spec:** `docs/2026-09-09-session-dashboard-design.md`

## Global Constraints

- Node 18+, pnpm (via `corepack enable`) as the package manager.
- Zero required runtime dependencies — built-in Node modules only.
- No frontend framework or build step — plain HTML/CSS/JS served as static files.
- Server binds to `127.0.0.1` only, never `0.0.0.0`. No authentication layer.
- The only process the server ever spawns is the one whitelisted `cmd /c start ... cmd /k "<templated command>"` pattern, with fields sourced only from its own `/api/sessions` output.
- `.env` is gitignored; only `.env.example` (placeholders, no real paths) is committed.
- Dark theme only; all motion respects `prefers-reduced-motion: reduce`.
- No automated test suite (per spec's Testing section) — every task verifies with a concrete manual command/action and an exact expected result, not an assertion framework.
- Repo lives at `C:\AE\ResumerAgent`, pushed to a **private** GitHub repo.

---

## File Structure

```
ResumerAgent/
  README.md
  package.json
  .gitignore
  .env.example
  server.mjs
  lib/
    config.mjs             SESSIONS_ROOT / RESUME_COMMAND / ATTACH_COMMAND / PORT resolution
    pathEncoding.mjs        cwd -> Claude Code "projects" folder name
    sessionRegistry.mjs     reads sessions/*.json, dedups by name
    liveAgents.mjs          runs `claude agents --json --all`
    transcriptPreview.mjs   last user message from a session's .jsonl
    mergeSessions.mjs       combines registry + live + preview into API shape
    resumeCommand.mjs       template substitution for the spawned command
  public/
    index.html
    styles.css
    app.js
  docs/
    2026-09-09-session-dashboard-design.md   (already written)
    superpowers/plans/2026-09-09-resumer-agent.md  (this file)
```

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Produces: `pnpm start` script (used by Task 9's manual verification onward).

- [ ] **Step 1: Initialize git and pnpm**

```bash
cd C:\AE\ResumerAgent
git init
corepack enable
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "resumer-agent",
  "version": "1.0.0",
  "description": "Local dashboard for finding and resuming dead/live Claude Code sessions across directories.",
  "type": "module",
  "private": true,
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node server.mjs"
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
.env
```

- [ ] **Step 4: Create `.env.example`**

```
# Directory containing Claude Code's "sessions" and "projects" folders.
# Defaults to $CLAUDE_CONFIG_DIR, then ~/.claude, if unset.
# SESSIONS_ROOT=C:\AE\claude-work

# Command templates used to resume/attach a session.
# Placeholders: {cwd}, {sessionId}, {id}
# Defaults below match a native Claude Code install with `claude` on PATH.
# RESUME_COMMAND=cd /d "{cwd}" && claude --resume {sessionId}
# ATTACH_COMMAND=claude attach {id}

# Port for the local dashboard server.
# PORT=4317
```

- [ ] **Step 5: Create `README.md`**

```markdown
# ResumerAgent

A small local dashboard for finding and resuming Claude Code sessions —
especially the ones that die when a terminal closes or the machine shuts
down and would otherwise be lost.

Claude Code already has `claude agents`, a terminal dashboard for every
*live* session across every directory. ResumerAgent covers what that
doesn't: dead interactive sessions, shown alongside the live ones, in a
browser, with one click to reopen a terminal on the right one.

## Requirements

- **Windows only.** Resume/Attach open a new terminal via `cmd.exe`,
  hardcoded — there's no cross-platform way to configure around this, so
  this tool doesn't run usefully on macOS/Linux as-is.
- Node.js 18+
- pnpm (`corepack enable` if you don't have it — it ships with Node)
- Claude Code CLI (`claude`) reachable on PATH for the live-session overlay
  and for the resume/attach commands themselves

## Setup

\`\`\`bash
pnpm install
cp .env.example .env   # optional — only needed if your setup isn't a default native install
pnpm start
\`\`\`

This starts a server on `http://127.0.0.1:4317` and opens it in your
browser. `Ctrl+C` to stop; nothing runs when you're not using it.

## Configuration

Two things, both optional, set via `.env` or your shell:

- `SESSIONS_ROOT` — directory containing Claude Code's `sessions/` and
  `projects/` folders. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`.
- `RESUME_COMMAND` / `ATTACH_COMMAND` — command templates
  (`{cwd}`, `{sessionId}`, `{id}` placeholders) run when you click
  Resume/Attach. Defaults assume a native install with `claude` on PATH.

### Running Claude Code through Docker?

Your session files live inside the container. If your container mounts its
Claude config directory to a host path, set `SESSIONS_ROOT` to that host
path. Set `RESUME_COMMAND`/`ATTACH_COMMAND` to whatever actually invokes
`claude` for you, e.g.:

\`\`\`
RESUME_COMMAND=docker exec -it my-claude-container claude --resume {sessionId}
ATTACH_COMMAND=docker exec -it my-claude-container claude attach {id}
\`\`\`

## How it works

See `docs/2026-09-09-session-dashboard-design.md` for the full design.
Short version: it reads Claude Code's own per-session registry files plus
`claude agents --json --all`, merges them, and shows one dashboard.
```

> Superseded 2026-09-16: the "Windows only" requirement above was true at
> plan time but no longer is — `feature/cross-platform` added macOS/Linux
> terminal spawning and a `TERMINAL_COMMAND` override. See the current
> `README.md`, not this quoted snapshot, for up-to-date requirements.

- [ ] **Step 6: Verify and commit**

Run: `git status` — expect to see the four new files untracked, nothing else.

```bash
git add package.json .gitignore .env.example README.md docs
git commit -m "chore: scaffold ResumerAgent project"
```

---

### Task 2: Config resolution

**Files:**
- Create: `lib/config.mjs`

**Interfaces:**
- Produces: `loadConfig(env = process.env) -> { sessionsRoot: string, resumeCommand: string, attachCommand: string, port: number }`. Also reads an optional `.env` file at the repo root (real `env`/`process.env` values take precedence over it).

- [ ] **Step 1: Create `lib/config.mjs`**

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Zero-dependency .env reader — no `dotenv` package (this project has no
// required runtime dependencies), and Node's built-in --env-file flag
// would tie the `start` script to a specific Node version floor. Real
// process.env values still win over .env (spread order below), matching
// the usual dotenv convention of "shell overrides file".
function loadDotEnv(dir = REPO_ROOT) {
  let content;
  try {
    content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

export function loadConfig(env = process.env) {
  const merged = { ...loadDotEnv(), ...env };

  const sessionsRoot = merged.SESSIONS_ROOT
    || merged.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');

  const resumeCommand = merged.RESUME_COMMAND
    || 'cd /d "{cwd}" && claude --resume {sessionId}';

  const attachCommand = merged.ATTACH_COMMAND
    || 'claude attach {id}';

  const port = Number.parseInt(merged.PORT, 10) || 4317;

  return { sessionsRoot, resumeCommand, attachCommand, port };
}
```

- [ ] **Step 2: Manually verify defaults and overrides**

Run:
```bash
node -e "import('./lib/config.mjs').then(m => console.log(m.loadConfig({CLAUDE_CONFIG_DIR:'C:\\\\AE\\\\claude-work'})))"
```
Expected: prints an object with `sessionsRoot: 'C:\\AE\\claude-work'`, the default `resumeCommand`/`attachCommand` strings above, `port: 4317`.

Run:
```bash
node -e "import('./lib/config.mjs').then(m => console.log(m.loadConfig({SESSIONS_ROOT:'X', PORT:'9999'})))"
```
Expected: `sessionsRoot: 'X'`, `port: 9999` — explicit `SESSIONS_ROOT`/`PORT` override the fallback chain.

- [ ] **Step 3: Commit**

```bash
git add lib/config.mjs
git commit -m "feat: resolve sessions root and command templates from env"
```

---

### Task 3: Path encoding

**Files:**
- Create: `lib/pathEncoding.mjs`

**Interfaces:**
- Produces: `encodeCwdForProjectDir(cwd: string) -> string`

- [ ] **Step 1: Create `lib/pathEncoding.mjs`**

```js
// Claude Code encodes a working directory into its "projects" folder name by
// replacing path-separator-ish characters with '-'. Inferred from observed
// examples on this machine:
//   C:\AE\claude-work        -> C--AE-claude-work
//   C:\GitRepos\dwh_il       -> C--GitRepos-dwh-il
//   C:\GitRepos\SPOT1        -> C--GitRepos-SPOT1
// Best-effort, used only for an optional preview snippet: if it's ever wrong
// for some path shape, the effect is a missing preview, nothing else breaks.
export function encodeCwdForProjectDir(cwd) {
  return cwd.replace(/[:\\/_.]/g, '-');
}
```

- [ ] **Step 2: Manually verify against the three known examples**

Run:
```bash
node -e "import('./lib/pathEncoding.mjs').then(m => {
  console.log(m.encodeCwdForProjectDir('C:\\\\AE\\\\claude-work'));
  console.log(m.encodeCwdForProjectDir('C:\\\\GitRepos\\\\dwh_il'));
  console.log(m.encodeCwdForProjectDir('C:\\\\GitRepos\\\\SPOT1'));
})"
```
Expected output, exactly:
```
C--AE-claude-work
C--GitRepos-dwh-il
C--GitRepos-SPOT1
```

- [ ] **Step 3: Commit**

```bash
git add lib/pathEncoding.mjs
git commit -m "feat: encode cwd into Claude Code's projects folder name"
```

---

### Task 4: Session registry reader

**Files:**
- Create: `lib/sessionRegistry.mjs`

**Interfaces:**
- Produces: `readSessionRegistry(sessionsRoot: string) -> Array<{ name, sessionId, cwd, kind?, status?, updatedAt?, startedAt?, jobId? }>` (one entry per distinct `name`, the freshest by `updatedAt` when duplicates exist; malformed/incomplete files are skipped silently).

- [ ] **Step 1: Create `lib/sessionRegistry.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';

export function readSessionRegistry(sessionsRoot) {
  const dir = path.join(sessionsRoot, 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const byName = new Map();
  for (const file of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!entry.name || !entry.sessionId || !entry.cwd) continue;

    const existing = byName.get(entry.name);
    if (!existing || (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byName.set(entry.name, entry);
    }
  }

  return [...byName.values()];
}
```

- [ ] **Step 2: Manually verify against real data on this machine**

Run:
```bash
node -e "import('./lib/sessionRegistry.mjs').then(m => console.log(m.readSessionRegistry('C:\\\\AE\\\\claude-work')))"
```
Expected: an array with one entry per session name currently under
`C:\AE\claude-work\sessions` (e.g. `PHOENIX-18579`, `spot1-4c`,
`MonitoringAgent`, `MotherAgent`, `dwh-il-6b`), each with `name`, `sessionId`,
`cwd` populated — no duplicates, no crash.

Run with a nonexistent root to confirm it degrades gracefully:
```bash
node -e "import('./lib/sessionRegistry.mjs').then(m => console.log(m.readSessionRegistry('C:\\\\does-not-exist')))"
```
Expected: `[]`, no error thrown.

- [ ] **Step 3: Commit**

```bash
git add lib/sessionRegistry.mjs
git commit -m "feat: read and dedup the per-process session registry"
```

---

### Task 5: Live agents reader

**Files:**
- Create: `lib/liveAgents.mjs`

**Interfaces:**
- Produces: `readLiveAgents() -> Promise<Array<{ pid, id?, cwd, kind, startedAt, sessionId, name, status, state? }> | null>` — `null` (not `[]`) if `claude` isn't on PATH, the command fails, or output can't be parsed as an array — `null` means "liveness could not be determined" and callers must treat it as unknown, never as "nothing is live". Never throws.

- [ ] **Step 1: Create `lib/liveAgents.mjs`**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Returns null (not []) on any failure — null means "could not determine
// liveness", which callers must treat as unknown, not as "nothing is
// live". Conflating the two let a slow/failed CLI call make a genuinely
// live interactive session look safely dead (caught in the final review).
export async function readLiveAgents() {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['agents', '--json', '--all'],
      { shell: true, windowsHide: true, timeout: 5000 }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Manually verify against real live sessions**

Run:
```bash
node -e "import('./lib/liveAgents.mjs').then(m => m.readLiveAgents().then(console.log))"
```
Expected: an array matching `claude agents --json --all` run directly in the
same terminal — same session names/pids currently alive.

- [ ] **Step 3: Commit**

```bash
git add lib/liveAgents.mjs
git commit -m "feat: query live sessions via claude agents --json --all"
```

---

### Task 6: Transcript preview

**Files:**
- Create: `lib/transcriptPreview.mjs`

**Interfaces:**
- Consumes: `encodeCwdForProjectDir` from `lib/pathEncoding.mjs`.
- Produces: `readTranscriptPreview(sessionsRoot: string, cwd: string, sessionId: string) -> string | null` — first line of the most recent user message, truncated to 140 chars with a trailing `…`, or `null` if the transcript is missing/unparsable.

- [ ] **Step 1: Create `lib/transcriptPreview.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

const MAX_TAIL_BYTES = 200_000;

export function readTranscriptPreview(sessionsRoot, cwd, sessionId) {
  const file = path.join(
    sessionsRoot,
    'projects',
    encodeCwdForProjectDir(cwd),
    `${sessionId}.jsonl`
  );

  let raw;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    raw = buffer.toString('utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let line;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (line.type !== 'user' || !line.message?.content) continue;

    const content = line.message.content;
    const text = Array.isArray(content)
      ? content.find((c) => c.type === 'text')?.text
      : typeof content === 'string' ? content : null;

    if (text) {
      const firstLine = text.split('\n')[0].trim();
      return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return null;
}
```

- [ ] **Step 2: Manually verify against a real transcript**

Pick one real `sessionId`/`cwd` pair from Task 4's output (e.g. the
`MonitoringAgent` entry). Run:
```bash
node -e "import('./lib/transcriptPreview.mjs').then(m => console.log(m.readTranscriptPreview('C:\\\\AE\\\\claude-work', '<cwd-from-task-4>', '<sessionId-from-task-4>')))"
```
Expected: a short string that matches (or is a truncation of) that
session's actual last user message — check it against `claude agents` or
the terminal window itself.

Run with a made-up sessionId to confirm graceful failure:
```bash
node -e "import('./lib/transcriptPreview.mjs').then(m => console.log(m.readTranscriptPreview('C:\\\\AE\\\\claude-work', 'C:\\\\nowhere', 'not-a-real-id')))"
```
Expected: `null`, no error thrown.

- [ ] **Step 3: Commit**

```bash
git add lib/transcriptPreview.mjs
git commit -m "feat: extract a one-line preview from a session's transcript"
```

---

### Task 7: Merge logic

**Files:**
- Create: `lib/mergeSessions.mjs`

**Interfaces:**
- Consumes: arrays shaped like `readSessionRegistry`'s and `readLiveAgents`'s output; a `getPreview(cwd, sessionId) -> string | null` callback (matches `readTranscriptPreview`'s signature with the first argument pre-bound).
- Produces: `mergeSessions(registryEntries, liveEntries, getPreview) -> Array<{ name, sessionId, id, cwd, kind: 'interactive'|'background', live: boolean, liveUnknown: boolean, status, updatedAt, preview }>`, sorted by `updatedAt` descending. `liveEntries` may be `null` (see `readLiveAgents`'s updated contract) — every merged entry then gets `liveUnknown: true, live: false`.

- [ ] **Step 1: Create `lib/mergeSessions.mjs`**

```js
function normalizeKind(kind) {
  return kind === 'bg' || kind === 'background' ? 'background' : 'interactive';
}

// liveEntries is null when readLiveAgents() couldn't determine liveness
// (see lib/liveAgents.mjs) — every merged session then gets
// liveUnknown: true and live: false, so callers can distinguish
// "confirmed dead" from "we don't actually know" instead of treating a
// failed liveness check as equivalent to a successful empty one.
export function mergeSessions(registryEntries, liveEntries, getPreview) {
  const liveUnknown = liveEntries === null;
  const entries = liveUnknown ? [] : liveEntries;
  const liveBySessionId = new Map(entries.map((e) => [e.sessionId, e]));

  const merged = registryEntries.map((entry) => {
    const live = liveBySessionId.get(entry.sessionId);
    return {
      name: entry.name,
      sessionId: entry.sessionId,
      id: live?.id ?? entry.jobId ?? null,
      cwd: entry.cwd,
      kind: normalizeKind(live?.kind ?? entry.kind),
      live: liveUnknown ? false : Boolean(live),
      liveUnknown,
      status: live?.status ?? entry.status ?? 'unknown',
      updatedAt: entry.updatedAt ?? entry.startedAt ?? 0,
      preview: getPreview(entry.cwd, entry.sessionId),
    };
  });

  // Live sessions with no registry file yet (freshly started, daemon hasn't
  // written one this run) still show up. Only possible when liveUnknown is
  // false, since entries is [] otherwise.
  for (const live of entries) {
    if (merged.some((m) => m.sessionId === live.sessionId)) continue;
    merged.push({
      name: live.name,
      sessionId: live.sessionId,
      id: live.id ?? null,
      cwd: live.cwd,
      kind: normalizeKind(live.kind),
      live: true,
      liveUnknown: false,
      status: live.status,
      updatedAt: live.startedAt ?? 0,
      preview: getPreview(live.cwd, live.sessionId),
    });
  }

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

- [ ] **Step 2: Manually verify merge and sort behavior**

Run:
```bash
node -e "
import('./lib/mergeSessions.mjs').then(({ mergeSessions }) => {
  const registry = [
    { name: 'dead-one', sessionId: 's1', cwd: 'C:\\\\x', updatedAt: 100 },
    { name: 'both', sessionId: 's2', cwd: 'C:\\\\y', updatedAt: 200 },
  ];
  const live = [
    { sessionId: 's2', name: 'both', cwd: 'C:\\\\y', kind: 'interactive', status: 'busy', startedAt: 50 },
    { sessionId: 's3', name: 'live-only', cwd: 'C:\\\\z', kind: 'bg', status: 'idle', startedAt: 300 },
  ];
  console.log(mergeSessions(registry, live, () => null).map(s => [s.name, s.live, s.status, s.updatedAt]));
});
"
```
Expected output (order matters — sorted by `updatedAt` descending):
```
[ [ 'live-only', true, 'idle', 300 ], [ 'both', true, 'busy', 200 ], [ 'dead-one', false, 'unknown', 100 ] ]
```
This confirms: registry+live merge by `sessionId`, live status/kind wins
over registry's stale copy, live-only sessions are included, and sort order
is correct.

- [ ] **Step 3: Commit**

```bash
git add lib/mergeSessions.mjs
git commit -m "feat: merge session registry with live agent status"
```

---

### Task 8: Resume command builder

**Files:**
- Create: `lib/resumeCommand.mjs`

**Interfaces:**
- Consumes: a session object shaped like `mergeSessions`'s output items (`live`, `kind`, `id`, `cwd`, `sessionId`).
- Produces: `buildResumeCommand({ session, resumeTemplate, attachTemplate }) -> string` — the fully substituted shell command to spawn.

- [ ] **Step 1: Create `lib/resumeCommand.mjs`**

```js
export function buildResumeCommand({ session, resumeTemplate, attachTemplate }) {
  const useAttach = session.live && session.kind === 'background' && session.id;
  const template = useAttach ? attachTemplate : resumeTemplate;

  return template
    .replaceAll('{cwd}', session.cwd)
    .replaceAll('{sessionId}', session.sessionId)
    .replaceAll('{id}', session.id ?? '');
}
```

- [ ] **Step 2: Manually verify both branches**

Run:
```bash
node -e "
import('./lib/resumeCommand.mjs').then(({ buildResumeCommand }) => {
  const resumeTemplate = 'cd /d \"{cwd}\" && claude --resume {sessionId}';
  const attachTemplate = 'claude attach {id}';
  console.log(buildResumeCommand({ session: { live: false, kind: 'interactive', cwd: 'C:\\\\x', sessionId: 'abc' }, resumeTemplate, attachTemplate }));
  console.log(buildResumeCommand({ session: { live: true, kind: 'background', id: 'b485', cwd: 'C:\\\\y', sessionId: 'def' }, resumeTemplate, attachTemplate }));
});
"
```
Expected output:
```
cd /d "C:\x" && claude --resume abc
claude attach b485
```

- [ ] **Step 3: Commit**

```bash
git add lib/resumeCommand.mjs
git commit -m "feat: build the resume/attach command from a session and template"
```

---

### Task 9: HTTP server

**Files:**
- Create: `server.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 2), `readSessionRegistry` (Task 4), `readLiveAgents` (Task 5, now returns `Array | null`), `readTranscriptPreview` (Task 6), `mergeSessions` (Task 7, now also produces `liveUnknown`), `buildResumeCommand` (Task 8) — all exact names/signatures as defined in those tasks.
- Produces: a running HTTP server on `127.0.0.1:<port>` serving `GET /`, static files from `public/`, `GET /api/sessions`, `POST /api/resume`. `POST /api/resume` now takes `{ sessionId }` only and resolves everything else server-side — see the code below and the design doc's "Hardening, round 2" for why.

- [ ] **Step 1: Create `server.mjs`**

```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn } from 'node:child_process';

import { loadConfig } from './lib/config.mjs';
import { readSessionRegistry } from './lib/sessionRegistry.mjs';
import { readLiveAgents } from './lib/liveAgents.mjs';
import { readTranscriptPreview } from './lib/transcriptPreview.mjs';
import { mergeSessions } from './lib/mergeSessions.mjs';
import { buildResumeCommand } from './lib/resumeCommand.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const MAX_BODY_BYTES = 10 * 1024;

const config = loadConfig();
const ALLOWED_HOSTS = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];

async function getSessionsPayload() {
  const [registryEntries, liveEntries] = await Promise.all([
    Promise.resolve(readSessionRegistry(config.sessionsRoot)),
    readLiveAgents(),
  ]);

  return mergeSessions(
    registryEntries,
    liveEntries,
    (cwd, sessionId) => readTranscriptPreview(config.sessionsRoot, cwd, sessionId)
  );
}

// Binding to 127.0.0.1 only blocks requests from OUTSIDE the machine — it
// does nothing to stop another web page open in the same browser from
// calling this API. A request with no Origin header at all (curl,
// same-origin navigation) is allowed; one with a mismatched Origin is not.
function isRequestAllowed(req) {
  if (!ALLOWED_HOSTS.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_HOSTS.some((host) => origin === `http://${host}`);
}

function serveStatic(req, res) {
  const requestedPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
  }
  return body;
}

function sanitizeTitle(session) {
  const sanitize = (value) => String(value ?? '').replace(/[^A-Za-z0-9 _.-]/g, '');
  const safe = sanitize(session.name);
  const safeFallback = sanitize(session.sessionId);
  return `Claude: ${safe || safeFallback || 'session'}`;
}

// A live session is only ever actioned if it's a background job with a
// real id (claude attach <id> — a view, never a resume). Everything else
// live — interactive, or background missing its id — is refused. This is
// an allowlist of the one proven-safe case, not a blacklist of the one
// known-bad case, so a session shape nobody's thought of yet still fails
// closed. liveUnknown (readLiveAgents() couldn't determine liveness) is
// refused unconditionally, before this check even runs.
function canSafelyAct(session) {
  if (session.liveUnknown) return false;
  if (!session.live) return true;
  return session.kind === 'background' && typeof session.id === 'string' && session.id.length > 0;
}

async function handleResume(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody) ||
    typeof requestBody.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid request: expected an object with sessionId');
    return;
  }

  // Everything below comes from the server's own fresh lookup, never from
  // the request body — requestBody.sessionId is only ever a lookup key.
  // This is the fix for the gap the final review found: an earlier
  // version trusted cwd/live/kind straight from the request body, which
  // meant the safety guard below was only as good as whatever the client
  // happened to send.
  const sessions = await getSessionsPayload();
  const session = sessions.find((s) => s.sessionId === requestBody.sessionId);

  if (!session) {
    res.writeHead(404).end('Unknown session');
    return;
  }

  if (!canSafelyAct(session)) {
    res.writeHead(session.liveUnknown ? 409 : 400).end('Refusing to act on this session');
    return;
  }

  try {
    const command = buildResumeCommand({
      session,
      resumeTemplate: config.resumeCommand,
      attachTemplate: config.attachCommand,
    });

    const title = sanitizeTitle(session);
    spawn('cmd.exe', ['/c', 'start', title, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
      .on('error', (err) => console.error('Failed to spawn resume terminal:', err))
      .unref();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, command }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

const server = http.createServer(async (req, res) => {
  if (!isRequestAllowed(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.url === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await getSessionsPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.url === '/api/resume' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') {
      res.writeHead(415).end('Unsupported Content-Type');
      return;
    }
    try {
      await handleResume(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`ResumerAgent dashboard: ${url}`);
  exec(`cmd /c start "" "${url}"`, (err) => {
    if (err) console.error('Failed to open browser:', err);
  });
});
```

**Safety rule for every step below (and for all future work on this
project): never send a request that would resume/attach against a REAL
LIVE session's `sessionId`.** Doing this against a real live session on
2026-09-09 destabilized other unrelated live sessions on this machine.
A real *dead* session is safe to target (that's the tool's actual
purpose) and a fabricated/synthetic dead session (see below) is always
safe. `GET /api/sessions` itself is read-only and safe against real data
regardless of liveness, as in every prior task.

- [ ] **Step 2: Manually verify the API endpoints**

Since `public/` doesn't exist yet (Tasks 10-11), temporarily verify just the
API. Run the server in the background:
```bash
node server.mjs &
sleep 1
curl -s http://127.0.0.1:4317/api/sessions
```
Expected: a JSON array matching Task 7's shape (now including
`liveUnknown` on every entry, `false` in the normal case), populated with
this machine's real sessions. Note: a browser tab will also pop open
(from the `exec` call) pointing at a page that 404s until Task 10 exists
— that's expected at this point.

Verify the crash-safety and validation fixes with a malformed body:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4317/api/resume -H "Content-Type: application/json" -d 'null'
curl -s http://127.0.0.1:4317/api/sessions > /dev/null && echo "server still up"
```
Expected: `400` for the malformed request, then `server still up`.

Verify the origin/host gate:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4317/api/sessions -H "Origin: http://evil.example"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4317/api/sessions -H "Host: evil.example"
```
Expected: `403` for both.

Verify unknown-session handling (safe — no real or fake session has this
id):
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:4317/api/resume -H "Content-Type: application/json" -d '{"sessionId":"does-not-exist"}'
```
Expected: `404`.

Verify the resume path end-to-end using a **temporary fake registry
file** — never a real session, dead or alive. This is the only way to
exercise the full server-side-lookup path safely, since the endpoint now
ignores everything in the request body except `sessionId` and resolves
the rest itself:
```bash
cat > "$SESSIONS_ROOT_FOR_TEST/sessions/test-e2e.json" <<'EOF'
{"pid":999999,"sessionId":"test-e2e-1234","cwd":"C:\\nonexistent-test-dir","name":"e2e-test x\" & calc.exe & \"","status":"idle","updatedAt":9999999999999}
EOF
curl -s -w "\n%{http_code}\n" -X POST http://127.0.0.1:4317/api/resume -H "Content-Type: application/json" -d '{"sessionId":"test-e2e-1234"}'
rm "$SESSIONS_ROOT_FOR_TEST/sessions/test-e2e.json"
```
(Replace `$SESSIONS_ROOT_FOR_TEST` with the real `sessions/` directory
under this machine's `SESSIONS_ROOT` — the same one Task 4 read from.)
Expected: `200` with a `command` field. A terminal window opens titled
something like `Claude: e2e-test x  calc.exe  ` (the sanitizer strips `"`
and `&` — confirm the title shows no sign the injected fragment survived
as a separate command) and harmlessly reports it can't resume the
nonexistent `test-e2e-1234` session against the nonexistent directory.
Close that window when done; delete the temp file even if the request
failed, so no fake session lingers in the real registry.

Verify the fail-closed liveness path (safe — this only proves the code
degrades correctly when the CLI is unreachable, no real session is
targeted):
```bash
PATH="/usr/bin" node server.mjs &
sleep 1
curl -s http://127.0.0.1:4317/api/sessions | grep -o '"liveUnknown":true' | head -1
curl -s -w "\n%{http_code}\n" -X POST http://127.0.0.1:4317/api/resume -H "Content-Type: application/json" -d '{"sessionId":"anything"}'
kill %1
```
Expected: at least one `"liveUnknown":true` in the sessions list (since
`claude` isn't reachable on the scrubbed `PATH`), and `404` for the resume
call (the fake `sessionId` still doesn't match anything — this step is
about confirming `liveUnknown` appears, not about triggering the 409
path, which would need a real matching registry entry combined with a
broken CLI; trust `canSafelyAct`'s code — `if (session.liveUnknown) return
false;` runs unconditionally before anything else — for that combination).

Confirm the previous, now-superseded test server is stopped and restart
normally for the next task:
```bash
kill %1
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: serve the sessions API and resume/attach endpoint"
```

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: serve the sessions API and resume/attach endpoint"
```

---

### Task 10: Frontend markup and styling

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`

**Interfaces:**
- Produces: DOM elements `app.js` (Task 11) binds to: `#last-refreshed`, `#refresh-btn`, `#grid`, `#empty`, `#error` with a `#retry-btn` inside it, `#toast`. CSS classes `app.js` toggles/uses: `.hidden`, `.card`, `.skeleton`, `.pill` + `.status-idle`/`.status-busy`/`.status-waiting`/`.status-resumable`, `.badge`, `.btn` + `.btn-primary`/`.btn-secondary`.

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ResumerAgent</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="topbar">
    <h1>ResumerAgent</h1>
    <div class="topbar-actions">
      <span id="last-refreshed" class="muted"></span>
      <button id="refresh-btn" class="icon-btn" title="Refresh now">⟳</button>
    </div>
  </header>

  <main id="content">
    <div id="grid" class="grid"></div>
    <div id="empty" class="empty hidden">No sessions found yet.</div>
    <div id="error" class="error-banner hidden">
      <span>Couldn't load sessions.</span>
      <button id="retry-btn">Retry</button>
    </div>
  </main>

  <div id="toast" class="toast hidden"></div>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/styles.css`**

```css
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --card-bg: #171a21;
  --card-border: #262b36;
  --text: #e7e9ee;
  --muted: #8b93a3;
  --accent: #7c6ce8;
  --green: #4caf7d;
  --blue: #5b8def;
  --amber: #e0a740;
  --gray: #5b6270;
  --radius: 10px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, "Segoe UI", Inter, sans-serif;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 28px;
  border-bottom: 1px solid var(--card-border);
}

.topbar h1 { font-size: 18px; margin: 0; font-weight: 600; }
.topbar-actions { display: flex; align-items: center; gap: 12px; }
.muted { color: var(--muted); font-size: 13px; }

.icon-btn {
  background: none;
  border: 1px solid var(--card-border);
  color: var(--text);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  transition: transform 150ms ease-out, background 150ms ease-out;
}
.icon-btn:hover { background: var(--card-border); }
.icon-btn:active { transform: scale(0.97); }
.icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

main { padding: 28px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: card-enter 250ms ease-out both;
  transition: transform 150ms ease-out, box-shadow 150ms ease-out;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

@keyframes card-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-name { font-size: 15px; margin: 0; font-weight: 600; }

.pill {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.status-idle { color: var(--green); background: rgba(76, 175, 125, 0.12); }
.status-busy { color: var(--blue); background: rgba(91, 141, 239, 0.12); }
.status-waiting { color: var(--amber); background: rgba(224, 167, 64, 0.12); }
.status-resumable { color: var(--gray); background: rgba(91, 98, 112, 0.15); }

.status-idle::before, .status-busy::before, .status-waiting::before {
  animation: pulse 2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .status-idle::before, .status-busy::before, .status-waiting::before { animation: none; }
  .card { animation: none; }
}
@keyframes pulse {
  0%, 100% { opacity: 0.85; }
  50% { opacity: 1; }
}

.card-cwd {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.badge {
  background: var(--card-border);
  color: var(--muted);
  border-radius: 6px;
  padding: 2px 8px;
}

.card-preview {
  font-style: italic;
  font-size: 13px;
  color: var(--text);
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-actions { margin-top: auto; }

.btn {
  width: 100%;
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: transform 150ms ease-out, opacity 150ms ease-out;
}
.btn:active { transform: scale(0.97); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn:disabled { opacity: 0.6; cursor: default; }

.btn-primary { background: var(--accent); color: white; }
.btn-secondary { background: var(--card-border); color: var(--muted); }

.card.skeleton {
  min-height: 140px;
  background: linear-gradient(90deg, var(--card-bg) 25%, var(--card-border) 37%, var(--card-bg) 63%);
  background-size: 400% 100%;
  animation: skeleton-loading 1.4s ease infinite;
}
@keyframes skeleton-loading {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

.empty, .error-banner {
  text-align: center;
  color: var(--muted);
  padding: 60px 0;
}
.error-banner button {
  margin-left: 12px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
}

.hidden { display: none !important; }

.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 13px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
```

- [ ] **Step 3: Manually verify markup loads**

With the server running (`pnpm start` in one terminal), open
`http://127.0.0.1:4317` in a browser. Expected: dark page with the
"ResumerAgent" header and refresh button visible, empty grid below (no
`app.js` yet, so no cards) — no console errors about missing `styles.css`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat: add dashboard markup and dark theme styling"
```

---

### Task 11: Frontend interactivity and end-to-end verification

**Files:**
- Create: `public/app.js`

**Interfaces:**
- Consumes: `GET /api/sessions` (Task 9) response shape from `mergeSessions` (Task 7, now including `liveUnknown`); `POST /api/resume` (Task 9, now takes `{ sessionId }` only — the server resolves everything else itself).

- [ ] **Step 1: Create `public/app.js`**

```js
const POLL_INTERVAL_MS = 5000;

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const lastRefreshedEl = document.getElementById('last-refreshed');
const toastEl = document.getElementById('toast');

const cardsByKey = new Map();
let firstLoad = true;
let lastRefreshedAt = null;

function sessionKey(s) {
  return s.sessionId;
}

function statusLabel(session) {
  if (session.liveUnknown) return 'status unknown';
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session) {
  if (session.liveUnknown) return 'status-resumable';
  return session.live ? `status-${session.status}` : 'status-resumable';
}

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderCard(card, session) {
  // A live interactive session already has an open terminal elsewhere,
  // and a session whose liveness couldn't be confirmed might secretly be
  // one too — acting on either has no safe use, and doing so against a
  // real live session has previously destabilized other unrelated live
  // sessions on the same machine. This button is genuinely disabled (no
  // click handler attached at all), not just styled as secondary. The
  // server enforces the same rule independently and is the load-bearing
  // check (it re-resolves the session itself rather than trusting this
  // client) — this is only the client-side half of that defense.
  const alreadyOpen = session.live && session.kind === 'interactive';
  const disabled = alreadyOpen || session.liveUnknown;
  const label = alreadyOpen
    ? 'Already open elsewhere'
    : session.liveUnknown
    ? 'Status unknown'
    : session.live
    ? 'Attach'
    : 'Resume';
  card.innerHTML = `
    <div class="card-header">
      <h2 class="card-name">${escapeHtml(session.name)}</h2>
      <span class="pill ${statusClass(session)}">${escapeHtml(statusLabel(session))}</span>
    </div>
    <div class="card-cwd" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</div>
    <div class="card-meta">
      <span class="badge">${session.kind === 'background' ? 'background' : 'interactive'}</span>
      <span class="muted">${relativeTime(session.updatedAt)}</span>
    </div>
    ${session.preview ? `<p class="card-preview">${escapeHtml(session.preview)}</p>` : ''}
    <div class="card-actions">
      <button class="btn ${disabled ? 'btn-secondary' : 'btn-primary'}" data-action="resume" ${disabled ? 'disabled' : ''}>
        ${label}
      </button>
    </div>
  `;
  if (!disabled) {
    card.querySelector('[data-action="resume"]').addEventListener('click', () => resumeSession(session));
  }
}

function buildCard(session) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.key = sessionKey(session);
  renderCard(card, session);
  return card;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

async function resumeSession(session) {
  const card = grid.querySelector(`[data-key="${session.sessionId}"]`);
  const button = card.querySelector('[data-action="resume"]');
  button.disabled = true;
  button.textContent = '…';
  try {
    // Only sessionId is sent — the server resolves cwd/live/kind/id itself
    // from its own current session list rather than trusting this object,
    // which may be a few seconds stale from the last poll.
    const res = await fetch('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    showToast(`Opening terminal for ${session.name}…`);
  } catch {
    showToast(`Failed to resume ${session.name}`);
  } finally {
    renderCard(card, session);
  }
}

function renderSkeleton() {
  grid.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'card skeleton';
    grid.appendChild(skeleton);
  }
}

function renderSessions(sessions) {
  // renderSkeleton() appends placeholder cards directly to #grid without
  // registering them in cardsByKey, since they represent no real session.
  // Clear them here so they don't linger after the first successful load.
  grid.querySelectorAll('.skeleton').forEach((el) => el.remove());

  emptyEl.classList.toggle('hidden', sessions.length > 0);

  const seenKeys = new Set();
  sessions.forEach((session, index) => {
    const key = sessionKey(session);
    seenKeys.add(key);
    let card = cardsByKey.get(key);
    if (card) {
      renderCard(card, session);
    } else {
      card = buildCard(session);
      card.style.animationDelay = `${index * 30}ms`;
      cardsByKey.set(key, card);
      grid.appendChild(card);
    }
  });

  for (const [key, card] of cardsByKey) {
    if (!seenKeys.has(key)) {
      card.remove();
      cardsByKey.delete(key);
    }
  }
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(await res.text());
    const sessions = await res.json();
    errorEl.classList.add('hidden');
    renderSessions(sessions);
    // Store the actual fetch time — computing relativeTime(Date.now())
    // at render time is always "just now" by construction and silently
    // hides a feed that's stopped updating (caught in the final review).
    lastRefreshedAt = Date.now();
    lastRefreshedEl.textContent = `updated ${relativeTime(lastRefreshedAt)}`;
  } catch {
    if (firstLoad) {
      grid.innerHTML = '';
      errorEl.classList.remove('hidden');
    } else if (lastRefreshedAt) {
      // A poll failure after the first successful load must be visible,
      // not silent — acting on stale liveness data is exactly the kind
      // of mistake this project exists to design out of.
      lastRefreshedEl.textContent = `stale · last updated ${relativeTime(lastRefreshedAt)}`;
    }
  } finally {
    firstLoad = false;
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadSessions);
document.getElementById('retry-btn').addEventListener('click', loadSessions);

renderSkeleton();
loadSessions();
setInterval(loadSessions, POLL_INTERVAL_MS);
```

- [ ] **Step 2: End-to-end manual verification against real sessions**

Only steps 3 and 4 below trigger a real spawn, and both are safe by
construction: step 3 targets a session that is genuinely dead (nothing
else has it open), and step 4 only *attaches a view* to a live background
session (it cannot tear anything down). Do not attempt to click Resume on
any live *interactive* card — that button should not even be clickable
(step 5 confirms this).

```bash
pnpm start
```
In the browser that opens:
1. Expected: skeleton cards briefly, then real cards for every current
   session on this machine (matching Task 4/5's data) — names, status pills
   (`live · idle`/`live · busy`/`resumable`), monospace `cwd`, relative
   time, and (for sessions with a real transcript) an italic preview line.
2. Hover a card — expected: it lifts slightly with a shadow.
3. Click **Resume** on a `resumable` card (a card whose pill says
   `resumable`, i.e. `live: false`) — expected: a toast appears ("Opening
   terminal for …"), and a new terminal window opens, already `cd`'d into
   that session's directory mid-`claude --resume` (or having just started
   it).
4. Click **Attach** on a live *background* card (if one exists, e.g.
   `PHOENIX-18579`) — expected: a new terminal opens showing `claude attach`
   output for that session. This only opens a view into the still-running
   session; it does not stop or restart anything.
5. Confirm a live *interactive* card shows "Already open elsewhere" and its
   button is **actually disabled** — greyed out via the existing
   `.btn:disabled` style, and clicking it produces no network request (check
   the browser's network tab), no toast, no spawned terminal. This is not
   optional styling; do not treat a merely secondary-colored-but-clickable
   button as passing this check.
6. Close/kill one live interactive session's terminal, wait for the 5s
   poll — expected: that card's pill changes from `live · idle` to
   `resumable` without a full-page flicker (in-place diff, not
   rebuild-from-scratch), and its button becomes enabled/primary now that
   it's genuinely dead.
7. Temporarily rename `lib/liveAgents.mjs` to force `/api/sessions` to 500,
   reload — expected: the error banner with **Retry** appears, not a blank
   page. Rename it back and click Retry — expected: it recovers.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: render sessions, poll for live status, wire up resume/attach"
```

---

### Task 12: Publish to GitHub

**Files:** none (repo-level operation only)

- [ ] **Step 1: Confirm the working tree is clean and everything is committed**

```bash
git status
git log --oneline
```
Expected: `nothing to commit, working tree clean`; one commit per prior
task, in order.

- [ ] **Step 2: Create the private GitHub repo and push**

```bash
gh auth status || gh auth login
gh repo create ResumerAgent --private --source=. --remote=origin
git branch -M main
git push -u origin main
```
Expected: `gh repo create` prints the new repo's URL; `git push` succeeds
and `git status` afterward shows the local `main` branch tracking
`origin/main` with nothing to push.

- [ ] **Step 3: Sanity-check the pushed repo**

```bash
gh repo view --web
```
Expected: opens the repo in the browser, private, all files present
(`README.md`, `server.mjs`, `lib/`, `public/`, `docs/`) and no `.env` or
`node_modules/` committed.
