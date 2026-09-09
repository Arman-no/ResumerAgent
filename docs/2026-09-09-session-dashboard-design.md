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

**Known limitation:** a *live interactive* session already has an open
terminal window somewhere; there is no OS-independent way for this tool to
focus that existing window. The UI marks live-interactive cards as "already
open elsewhere" with a secondary/less prominent button, rather than
pretending it will focus the original window.

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
  (Resume/Attach), secondary Stop button only on live background sessions.

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
  the last real user message, live status matches `claude agents --json`,
  and clicking Resume/Attach opens a correctly targeted terminal.
- Manual: kill one live session's process, confirm it drops out of `live`
  but keeps showing as `resumable`.
- No automated test suite — single-user local utility; manual verification
  against real session data is the right bar.
