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
- Produces: `loadConfig(env = process.env) -> { sessionsRoot: string, resumeCommand: string, attachCommand: string, port: number }`

- [ ] **Step 1: Create `lib/config.mjs`**

```js
import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const sessionsRoot = env.SESSIONS_ROOT
    || env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');

  const resumeCommand = env.RESUME_COMMAND
    || 'cd /d "{cwd}" && claude --resume {sessionId}';

  const attachCommand = env.ATTACH_COMMAND
    || 'claude attach {id}';

  const port = Number.parseInt(env.PORT, 10) || 4317;

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
- Produces: `readLiveAgents() -> Promise<Array<{ pid, id?, cwd, kind, startedAt, sessionId, name, status, state? }>>` — `[]` if `claude` isn't on PATH or the command fails; never throws.

- [ ] **Step 1: Create `lib/liveAgents.mjs`**

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readLiveAgents() {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['agents', '--json', '--all'],
      { shell: true, windowsHide: true, timeout: 5000 }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
- Produces: `mergeSessions(registryEntries, liveEntries, getPreview) -> Array<{ name, sessionId, id, cwd, kind: 'interactive'|'background', live: boolean, status, updatedAt, preview }>`, sorted by `updatedAt` descending.

- [ ] **Step 1: Create `lib/mergeSessions.mjs`**

```js
function normalizeKind(kind) {
  return kind === 'bg' || kind === 'background' ? 'background' : 'interactive';
}

export function mergeSessions(registryEntries, liveEntries, getPreview) {
  const liveBySessionId = new Map(liveEntries.map((e) => [e.sessionId, e]));

  const merged = registryEntries.map((entry) => {
    const live = liveBySessionId.get(entry.sessionId);
    return {
      name: entry.name,
      sessionId: entry.sessionId,
      id: live?.id ?? entry.jobId ?? null,
      cwd: entry.cwd,
      kind: normalizeKind(live?.kind ?? entry.kind),
      live: Boolean(live),
      status: live?.status ?? entry.status ?? 'unknown',
      updatedAt: entry.updatedAt ?? entry.startedAt ?? 0,
      preview: getPreview(entry.cwd, entry.sessionId),
    };
  });

  // Live sessions with no registry file yet (freshly started, daemon hasn't
  // written one this run) still show up.
  for (const live of liveEntries) {
    if (merged.some((m) => m.sessionId === live.sessionId)) continue;
    merged.push({
      name: live.name,
      sessionId: live.sessionId,
      id: live.id ?? null,
      cwd: live.cwd,
      kind: normalizeKind(live.kind),
      live: true,
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
- Consumes: `loadConfig` (Task 2), `readSessionRegistry` (Task 4), `readLiveAgents` (Task 5), `readTranscriptPreview` (Task 6), `mergeSessions` (Task 7), `buildResumeCommand` (Task 8) — all exact names/signatures as defined in those tasks.
- Produces: a running HTTP server on `127.0.0.1:<port>` serving `GET /`, static files from `public/`, `GET /api/sessions`, `POST /api/resume`.

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

const config = loadConfig();

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

function serveStatic(req, res) {
  const requestedPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
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

async function handleResume(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let session;
  try {
    session = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  const command = buildResumeCommand({
    session,
    resumeTemplate: config.resumeCommand,
    attachTemplate: config.attachCommand,
  });

  const title = `Claude: ${session.name ?? session.sessionId}`;
  spawn('cmd.exe', ['/c', 'start', title, 'cmd', '/k', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, command }));
}

const server = http.createServer(async (req, res) => {
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
    await handleResume(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`ResumerAgent dashboard: ${url}`);
  exec(`cmd /c start "" "${url}"`);
});
```

- [ ] **Step 2: Manually verify the API endpoints**

Since `public/` doesn't exist yet (Tasks 10-11), temporarily verify just the
API. Run the server in the background:
```bash
node server.mjs &
sleep 1
curl -s http://127.0.0.1:4317/api/sessions
```
Expected: a JSON array matching Task 7's shape, populated with this
machine's real sessions (same names as Task 4/5's manual checks). Note: a
browser tab will also pop open (from the `exec` call) pointing at a page
that 404s until Task 10 exists — that's expected at this point.

Stop the server:
```bash
kill %1
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
- Consumes: `GET /api/sessions` (Task 9) response shape from `mergeSessions` (Task 7); `POST /api/resume` (Task 9).

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

function sessionKey(s) {
  return s.sessionId;
}

function statusLabel(session) {
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session) {
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
  const alreadyOpen = session.live && session.kind === 'interactive';
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
      <button class="btn ${alreadyOpen ? 'btn-secondary' : 'btn-primary'}" data-action="resume">
        ${alreadyOpen ? 'Already open elsewhere' : session.live ? 'Attach' : 'Resume'}
      </button>
    </div>
  `;
  card.querySelector('[data-action="resume"]').addEventListener('click', () => resumeSession(session));
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
    const res = await fetch('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
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
    lastRefreshedEl.textContent = `updated ${relativeTime(Date.now())}`;
  } catch {
    if (firstLoad) {
      grid.innerHTML = '';
      errorEl.classList.remove('hidden');
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

```bash
pnpm start
```
In the browser that opens:
1. Expected: skeleton cards briefly, then real cards for every current
   session on this machine (matching Task 4/5's data) — names, status pills
   (`live · idle`/`live · busy`/`resumable`), monospace `cwd`, relative
   time, and (for sessions with a real transcript) an italic preview line.
2. Hover a card — expected: it lifts slightly with a shadow.
3. Click **Resume** on a `resumable` card — expected: a toast appears
   ("Opening terminal for …"), and a new terminal window opens, already
   `cd`'d into that session's directory mid-`claude --resume` (or having
   just started it).
4. Click **Attach** on a live *background* card (if one exists, e.g.
   `PHOENIX-18579`) — expected: a new terminal opens showing `claude attach`
   output for that session.
5. Confirm a live *interactive* card shows "Already open elsewhere" as a
   secondary (not primary-colored) button.
6. Close/kill one live interactive session's terminal, wait for the 5s
   poll — expected: that card's pill changes from `live · idle` to
   `resumable` without a full-page flicker (in-place diff, not
   rebuild-from-scratch).
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
