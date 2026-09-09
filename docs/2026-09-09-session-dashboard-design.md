# Session Resume Dashboard — Design

Date: 2026-09-09
Status: approved in chat, pending final spec review
Repo: `C:\AE\ResumerAgent` → private GitHub repo (created by Claude via `gh`)

## Problem

Claude Code sessions (`claude` CLI) run as plain OS processes in cmd/terminal
windows. When the machine shuts down or a window is closed, the process dies.
The conversation is still resumable (Claude Code keeps the transcript on
disk), but there is no built-in way to find it again if you don't remember
which directory it was started in.

Claude Code already ships `claude agents` — a full-screen terminal dashboard
listing every **live** session (interactive + background) across every
directory, with attach/resume/stop built in. That covers "which of my open
terminal windows is which" today; nothing needs to be built for it.

The gap, confirmed by comparing `claude agents --json` against
`claude agents --json --all`: once an **interactive** session's process is
gone, it disappears from `claude agents` entirely (`--all` only restores
completed **background** jobs). The only surviving trace of a dead
interactive session is a per-process registry file at
`<config-root>\sessions\<pid>.json` (confirmed one 6+ days old is still
present and untouched on this machine), containing its `name`, `sessionId`,
`cwd`, and status/timestamps — everything needed to resume it, just nothing
to browse it with.

## Goal

A small local web dashboard, launched on demand, that:
1. Lists dead/resumable interactive sessions (the actual gap) alongside a
   live overlay from `claude agents --json --all` (for a complete picture in
   one place).
2. Shows enough context per session to recognize it at a glance: name,
   working directory, status, last-active time, and a one-line preview of
   what it was about.
3. Lets you resume a dead session or attach to a live background one with
   one click, which opens a new terminal window running the right command.
4. Looks and feels professional — a small piece of software worth using
   daily, not a debug page.
5. **Runs unmodified on a colleague's machine**, including one who runs
   Claude Code through Docker rather than a native install — see
   Portability below.

Explicitly out of scope: reimplementing `claude agents` itself, remote/network
access (this is a single-user localhost tool), authentication, editing or
deleting sessions, showing full transcripts.

## Portability (native install vs. Docker)

This machine's native install sets `CLAUDE_CONFIG_DIR=C:\AE\claude-work`
(confirmed via env var), which is where `sessions/` and `projects/` live. A
colleague running Claude Code through Docker will have a different, unknown
layout: their session/transcript files live inside the container's
filesystem, and are only visible on their host if their container setup
mounts that config directory to a host path — which is specific to how they
run the container and not something this design can assume or hardcode.

Rather than guess at someone else's Docker invocation, the tool takes two
things as **configuration**, both with sensible zero-config defaults for the
native case:

- `SESSIONS_ROOT` — the directory containing `sessions/` and `projects/`.
  Default: `process.env.CLAUDE_CONFIG_DIR`, falling back to `~/.claude` if
  unset. A Docker user overrides this to whatever host path their container
  mounts that directory to.
- `RESUME_COMMAND` — a template for the command spawned on Resume/Attach,
  with `{cwd}` and `{sessionId}`/`{id}` placeholders. Default:
  `cd /d "{cwd}" && claude --resume {sessionId}` (and `claude attach {id}`
  for live background). A Docker user overrides this to whatever invokes
  their container's `claude` equivalent, e.g.
  `docker exec -it my-claude-container claude --resume {sessionId}`.

Both are read from environment variables, with an optional `.env` file (via
`dashboard/.env`, gitignored) for convenience — never committed, since a
colleague's path/command may reference their own local setup.

The README documents this explicitly for Docker users: "if your session
files aren't under the default location, or `claude` isn't a bare host
command for you, set `SESSIONS_ROOT` and `RESUME_COMMAND` accordingly." This
is deliberately left as documented configuration rather than auto-detected
Docker-specific logic, since the actual mount/invocation convention is
colleague-specific and unknown at design time.

## Architecture

```
ResumerAgent/                 (git repo root)
  README.md
  package.json                pnpm, "start" script
  .gitignore                   node_modules, .env
  .env.example                 documents SESSIONS_ROOT / RESUME_COMMAND
  server.mjs                   Node http server (no framework, uses node:http)
  public/
    index.html                 markup
    styles.css                 visual design
    app.js                     fetch + render + interactions
  docs/
    2026-09-09-session-dashboard-design.md   (this file)
```

**Launch:** `pnpm start` starts an HTTP server bound to `127.0.0.1:<port>`
(e.g. 4317) and opens the default browser to it. `Ctrl+C` stops it. Nothing
runs when not in use — on-demand launch model.

**Package manager:** pnpm via Corepack (`corepack enable`, bundled with
Node). No dependencies are strictly required (`node:http`,
`node:child_process`, `node:fs`); anything added later goes through pnpm.

### `GET /`
Serves `public/index.html` (which pulls in `styles.css` and `app.js` as
static files from the same server).

### `GET /api/sessions`
1. Reads every `<SESSIONS_ROOT>\sessions\*.json`.
2. Deduplicates by `name`, keeping the entry with the latest `updatedAt`.
3. Runs `claude agents --json --all` and marks any entry whose `sessionId`
   appears there as `live: true`, carrying over its live `status`
   (idle/busy/waiting) and `kind` (interactive/background).
4. For each session, reads the last few lines of its transcript at
   `<SESSIONS_ROOT>\projects\<encoded-cwd>\<sessionId>.jsonl` and extracts
   the most recent `type: "user"` message's text as a one-line preview
   (truncated, first line only). Missing/unparsable file → preview omitted,
   no error surfaced for this cosmetic field.
5. Returns a JSON array, newest `updatedAt` first (shape unchanged from the
   original design — see example in git history / README).

### `POST /api/resume`
Body: the exact session object the frontend received for that card (no
separate lookup). Builds the command from `RESUME_COMMAND` (or the
attach variant for live background sessions) by substituting `{cwd}`,
`{sessionId}`, `{id}` from that object — never from free-typed frontend
input — then spawns it via
`cmd /c start "Claude: <name>" cmd /k "<command>"`.

**Hardening (added after a real incident during Task 9's fix loop — see
below):** running `claude --resume <id>` against a session ID that is
*already live* is not just visually confusing, it is genuinely unsafe —
doing this against a real live session on 2026-09-09 triggered something in
the local Claude Code daemon that tore down other unrelated live terminal
sessions on the same machine. There is no safe reason for this tool to ever
send that request, so it is blocked at two layers, not styled away at one:

- **Server:** `POST /api/resume` rejects with `400` and does not build or
  spawn anything if `session.live === true && session.kind === 'interactive'`.
  This is the load-bearing check — it protects the machine even if the
  client is bypassed, stale, or wrong.
- **Client:** a card for a live *interactive* session renders its action
  button fully `disabled` (no click handler attached at all — not merely
  styled as secondary), labeled "Already open elsewhere". A live
  *background* session still gets an enabled Attach button (`claude attach
  <id>`), which only opens a **view** into the still-running session and
  cannot tear anything down — that action stays safe and is unaffected by
  this hardening. A dead session (`live: false`) still gets a fully enabled
  Resume button — resuming a session nothing else currently holds open is
  the tool's actual intended purpose and has no such risk.

**What actually happened (for future reference):** while manually verifying
that Task 9's resume endpoint still worked normally after fixing an
unrelated bug, a test used a real, currently-active session's ID (instead
of synthetic/fake test data) as the "does the happy path still work"
check. Shortly after that request executed, two other live interactive
terminal sessions on the machine closed and this dashboard-building
session's own process was replaced. The exact internal mechanism inside
Claude Code's daemon isn't fully known, but the causal chain (real resume
of a live ID → sessions torn down moments later) is clear enough that this
action is now treated as unsafe by design, not just by convention. Any
future manual verification of the resume/attach endpoints — in this
project or when extending it — must use synthetic fake IDs
(e.g. `sessionId: "test-1234"`, a `cwd` that doesn't need to exist) for
anything that actually spawns a process. A dead-but-real session is
*closer* to safe than a live one, but "fake data, verify the command
string, don't actually need to trigger a real spawn to prove the logic is
correct" is the preferred method going forward — it gives full confidence
in the code path with zero risk to anything real.

## UI/UX

Goal: a small tool that feels deliberately designed, not a debug page.

**Visual language**
- Dark theme (default and only theme). Neutral slate background
  (`#0f1115` body, `#171a21` cards), single accent color (muted violet or
  teal, finalized in implementation) used sparingly for primary actions and
  focus states only.
- System font stack (`-apple-system, "Segoe UI", Inter, sans-serif`).
- Status communicated by color **and** label together: `live · idle`
  (green), `live · busy` (blue), `live · waiting` (amber), `resumable`
  (neutral gray).

**Layout**
- Header: title, manual refresh icon-button, last-refreshed relative
  timestamp.
- Responsive card grid (`repeat(auto-fill, minmax(300px, 1fr))`), one card
  per session: name (bold), status pill, `cwd` in monospace
  (ellipsis-truncated, full path on hover), relative last-active time,
  italic one-line preview (2-line clamp), kind badge, primary action button
  (Resume for dead sessions / Attach for live background sessions /
  disabled "Already open elsewhere" for live interactive sessions — see
  Hardening under `POST /api/resume`), secondary Stop button only on live
  background sessions.

**Motion** (respecting `prefers-reduced-motion: reduce`)
- Cards fade + slide up on load, staggered ~30ms per card.
- Card hover: lift (`translateY(-2px)`) + soft shadow, ~150ms ease-out.
- Live-status pill: slow soft pulse (opacity 0.85↔1, ~2s loop).
- Button press: slight scale-down (`0.97`) on `:active`.
- Resume/Attach click: inline spinner, then an auto-dismissing toast
  ("Opening terminal for PHOENIX-18579…").

**States**
- Loading: skeleton cards, not a blank screen.
- Empty: "No sessions found yet."
- Error (`/api/sessions` fetch fails): inline banner with Retry — never a
  blank page.
- Keyboard: all buttons reachable by Tab with a visible focus ring.

**Polling:** re-fetch `/api/sessions` every 5s, diffing in place rather than
re-rendering the whole grid, so cards don't flicker or lose hover/focus
state on refresh.

## Safety

- Server binds explicitly to `127.0.0.1`, never `0.0.0.0`.
- No authentication layer — acceptable, local-only and single-user (each
  colleague runs their own instance against their own sessions).
- The server only reads files under `SESSIONS_ROOT`, and only ever spawns
  the one whitelisted `cmd /k` pattern with fields sourced from its own
  `/api/sessions` output — no arbitrary command execution from frontend
  input.
- Any free-text field from the request body (e.g. `name`) that ends up in
  a string later re-parsed by `cmd.exe` (the spawned window's title) is
  sanitized to `[A-Za-z0-9 _.-]` before use — `cmd.exe /c` re-parses its
  whole command line for its own metacharacters, so Node's argv quoting
  alone does not neutralize them.
- `/api/resume` rejects (`400`) any request whose `session.live === true
  && session.kind === 'interactive'` before building or spawning anything
  — see the Hardening note under `POST /api/resume` above.
- The server never crashes the whole process on a malformed or
  wrong-shaped request body; `/api/resume` validates the parsed body is a
  non-null object with the required fields before use, and wraps the rest
  of its logic in try/catch.
- `.env` (holding any machine-specific overrides) is gitignored; only
  `.env.example` (documented placeholders, no real paths) is committed —
  relevant now that this is a shared repo, not a personal script.

## Distribution

- Repo: `C:\AE\ResumerAgent`, pushed to a **private** GitHub repo (session
  previews can reference internal ticket IDs/work, so kept private).
- Colleague usage: `git clone`, `pnpm install`, copy `.env.example` to
  `.env` and adjust `SESSIONS_ROOT`/`RESUME_COMMAND` if they're not on a
  native install with default paths, `pnpm start`. README documents this
  end to end, including the Docker override example above.

## Testing

- Manual: run `pnpm start` with the current 3-4 real sessions on this
  machine present; verify the dashboard lists them, preview text matches
  the last real user message, live status matches `claude agents --json`.
- Manual: kill one live session's process, confirm it drops out of `live`
  but keeps showing as `resumable`.
- **Rule for verifying anything that spawns a process (Resume/Attach):
  always use synthetic fake session data** (a made-up `sessionId` such as
  `"test-1234"`, a `cwd` that need not exist) — never a real session's ID,
  live or dead. Confirm the built command string and that a terminal
  opens; there is no need to target a real session to prove the plumbing
  works, and doing so risks real side effects (see the Hardening note
  under `POST /api/resume`). This rule binds every task and every future
  change to this project, not just Task 9.
- No automated test suite — single-user local utility; manual verification
  against synthetic/read-only data (never a live spawn against a real
  session) is the right bar.
