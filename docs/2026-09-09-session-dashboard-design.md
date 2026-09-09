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
completed **background** jobs).

**Revision (2026-09-09, after real usage found the original approach didn't
work): the per-process registry file is not a durable record of dead
sessions.** The original design read `<config-root>\sessions\<pid>.json` as
the source of dead sessions, based on one observed case where a file from
an *ungracefully*-ended session (crash / force-kill / daemon takeover) was
still present 6+ days later. In real use, a normal clean exit (closing the
terminal window, typing `exit`) deletes that pointer file essentially
immediately — confirmed directly: closing a session's window made it
vanish from the registry within moments, while its actual transcript
under `projects/<encoded-cwd>/<sessionId>.jsonl` remained fully intact.
This is exactly backwards from what the tool needs: the pointer survives
the rare case (a crash) and disappears in the common case (closing a
terminal normally) — precisely the sessions this tool exists to recover.

**Fixed by scanning transcripts directly, not the pointer file.**
`claude --resume`'s own interactive picker (`Ctrl+A` to show all projects)
confirms transcripts are the right source — sessions with no surviving
registry pointer still show up there, with `cwd`, git branch, and file
size alongside a name. Each transcript line already embeds its own `cwd`
and `gitBranch`, so recovering these needs no lossy reverse-engineering of
the encoded folder name — see `lib/discoverSessions.mjs`. The registry
file is now only consulted afterward, to overlay a nicer name when Claude
Code happened to record one; it is no longer the primary source of dead
sessions.

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
access (this is a single-user localhost tool), authentication, editing
sessions, showing full transcripts. (Purging a confirmed-dead session — see
`POST /api/purge` below, added 2026-09-09 — is now in scope; it was
originally excluded here alongside "editing," but real use surfaced a
genuine need to declutter old/no-longer-wanted sessions.)

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

Both are read from environment variables, with an optional `.env` file at
the repo root (gitignored, loaded by `lib/config.mjs` itself — no
dependency) for convenience — never committed, since a colleague's
path/command may reference their own local setup.

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
  package.json                npm, "start"/"launch" scripts
  .gitignore                   node_modules, .env
  .env.example                 documents SESSIONS_ROOT / RESUME_COMMAND / ATTACH_COMMAND / PORT
  server.mjs                   Node http server (no framework, uses node:http)
  lib/
    config.mjs                 env + .env resolution
    pathEncoding.mjs           cwd -> Claude Code "projects" folder name
    sessionRegistry.mjs        reads sessions/*.json, dedups by name
    liveAgents.mjs             runs `claude agents --json --all`
    transcriptPreview.mjs      last user message from a session's .jsonl
    mergeSessions.mjs          combines registry + live + preview
    resumeCommand.mjs          template substitution for the spawned command
  public/
    index.html                 markup
    styles.css                 visual design
    app.js                     fetch + render + interactions
  docs/
    2026-09-09-session-dashboard-design.md   (this file)
```

**Launch:** `npm start` starts an HTTP server bound to `127.0.0.1:<port>`
(e.g. 4317) and opens the default browser to it. `Ctrl+C` stops it. Nothing
runs when not in use — on-demand launch model.

**Revision (2026-09-09, freshness fixes):** two related "why doesn't it show
my changes" gaps, both stemming from nothing guaranteeing the user is
looking at current code:
1. **Stale server process.** The desktop shortcut previously ran `npm start`
   directly. If a prior instance was still bound to the port (never closed,
   e.g. left running from a previous session), the new process hit
   `EADDRINUSE` and exited, leaving the user talking to whatever old code
   the surviving process happened to be running, with no indication it was
   outdated. Fixed by `scripts/launch.mjs` (invoked as `npm run launch`,
   what the desktop shortcut now points at): before starting, it looks up
   whatever process is listening on the configured port via `netstat`, and
   if — and only if — that process is `node.exe` (never anything else, to
   avoid touching an unrelated process that happens to hold the port), kills
   it first. The shortcut now always ends up running the code currently on
   disk.
2. **Stale browser tab.** Even with a fresh server, a browser tab left open
   from before a code change keeps running whatever `app.js` it already
   loaded into memory — polling `/api/sessions` for new data does nothing
   for new *rendering* code, since the tab never re-fetches its own
   `<script>`. Fixed by stamping every `/api/sessions` response with
   `startedAt` (the server process's boot time); `app.js` remembers the
   value from its first successful poll and shows a persistent "reload"
   banner the moment a later poll's value differs, i.e. the server it's
   talking to restarted since this tab loaded. Static files (`index.html`,
   `app.js`, `styles.css`) are also now served with `Cache-Control:
   no-store`, so a manual reload can never be served a disk-cached stale
   copy either. A tab that predates this fix has no way to know about it —
   this only prevents the failure mode going forward, one reload after
   deploying it is unavoidable.

**Package manager:** plain npm (ships with Node). No dependencies are
strictly required (`node:http`, `node:child_process`, `node:fs`).
**Revision (2026-09-09):** originally documented as pnpm via Corepack, but
real use on a corporate-managed Windows machine hit `corepack`'s pnpm
install being blocked outright — `This program is blocked by group policy`
— an IT-managed AppLocker/WDAC-style restriction on running an unsigned
native binary, not fixable from this project. Since there's nothing to
install anyway, npm is the documented path now; pnpm still works for
anyone whose machine allows it.

### `GET /`
Serves `public/index.html` (which pulls in `styles.css` and `app.js` as
static files from the same server).

### `GET /api/sessions`
1. Scans `<SESSIONS_ROOT>\projects\*\*.jsonl` for every transcript modified
   in the last 7 days — this is the primary source of sessions, dead or
   alive (see the Problem section's revision above for why). Each file's
   own `cwd` and `gitBranch` fields are read from a small prefix read (no
   need to tail-read or decode the folder name), along with its file size.
2. Reads every `<SESSIONS_ROOT>\sessions\*.json` (deduplicated by `name`,
   keeping the entry with the latest `updatedAt`) and overlays its `name`,
   `id`/`jobId`, `kind`, and `status` onto any transcript-discovered
   session with a matching `sessionId`, when present. Without a saved
   name, the session falls back to a name
   derived from its own preview text (see step 4), then the last path
   segment of `cwd`, then a short slice of its id — never Claude's own
   LLM-generated conversation titles (visible in `claude --resume`'s
   picker), which this tool has no cheap way to reproduce.
3. Runs `claude agents --json --all` and marks any entry whose `sessionId`
   appears there as `live: true`, carrying over its live `status`
   (idle/busy/waiting), `kind` (interactive/background), and `id`.
4. For each session, reads the last few lines of its transcript and
   extracts the most recent message that looks like something a person
   actually typed — skipping tool/system output stored under the same
   "user" role (`<local-command-stdout>`-style tags, bracket-wrapped
   artifacts, the auto-compaction summary banner, a skill's own
   invocation preamble; see `lib/transcriptPreview.mjs`'s
   `SYNTHETIC_TEXT_PREFIXES` — a best-effort list, not exhaustive) — as a
   one-line preview (truncated, first line only, ANSI codes stripped).
   Missing/unparsable file, or no non-synthetic message found → preview
   omitted, no error surfaced for this cosmetic field.
5. Returns a JSON array, newest `updatedAt` first, now also carrying
   `gitBranch` and `sizeBytes` per session (`null` for a live session
   whose transcript hasn't been discovered yet) and `liveUnknown` as
   before.

**Known scaling ceiling, not yet mitigated:** every 5s poll re-scans and
re-stats every `.jsonl` under `projects/*` (step 1) and re-reads a preview
tail for every session inside the 7-day window (step 4) — there is no
caching between polls. Fine at this project's real scale today (dozens of
files, low-single-digit MB each); worth revisiting with a cache keyed by
file mtime if `projects/` ever grows into the thousands of files or
individual transcripts into the tens of MB.

### `POST /api/resume`
Body: `{ "sessionId": "<the session's id>" }` — **nothing else from the
request body is trusted.** The server re-fetches its own current session
list (the same computation `GET /api/sessions` does) and looks the session
up by that `sessionId`; `cwd`, `live`, `kind`, `id`, and `name` all come
from that fresh server-side lookup, never from the client. This closed a
real gap found in the final review (see Hardening below): the first
version of this endpoint took `cwd`/`live`/`kind` etc. straight from the
POST body, which meant the safety guard below was only as good as
whatever the client happened to send — stale, spoofable, or simply wrong
if a poll raced a real state change.

Builds the command from `RESUME_COMMAND` (or the attach variant) by
substituting `{cwd}`, `{sessionId}`, `{id}` from that server-resolved
session, then spawns it via `cmd /c start "Claude: <name>" cmd /k
"<command>"`.

**Hardening, round 1 (added after a real incident during Task 9's original
fix loop):** running `claude --resume <id>` against a session ID that is
*already live* is not just visually confusing, it is genuinely unsafe —
doing this against a real live session on 2026-09-09 triggered something in
the local Claude Code daemon that tore down other unrelated live terminal
sessions on the same machine.

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
manual verification of the resume/attach endpoints — in this project or
when extending it — must use synthetic fake IDs (e.g. `sessionId:
"test-1234"`) for anything that actually spawns a process; asserting on
the returned `command` string is sufficient, no real spawn is needed to
prove the logic is correct.

**Hardening, round 2 (added after the final whole-branch review found the
round-1 guard didn't actually hold end to end):** three concrete problems
with round 1's design, and how each is closed:

1. **The guard trusted the request body's `live`/`kind` fields.** Fixed by
   the server-side lookup-by-`sessionId` described above — the client can
   no longer assert its own liveness; the server always uses its own
   freshest view.
2. **`readLiveAgents()` failed *open*:** any error (a `claude` CLI timeout,
   not on PATH, malformed output) made it return `[]`, which `mergeSessions`
   read as "nothing is live" — so a slow `claude agents` call could make a
   genuinely live interactive session look dead, and the (now-correct)
   guard would wave it through. Fixed: `readLiveAgents()` returns `null`
   on failure, distinct from `[]` (empty on success). `mergeSessions` marks
   every session `liveUnknown: true` when given `null`, and `/api/resume`
   refuses (`409`) if the resolved session has `liveUnknown: true` — fail
   **closed** when liveness can't be confirmed, not open. The UI disables
   the action button the same way it does for "already open elsewhere",
   labeled "Status unknown".
3. **The safe-path check was a narrow blacklist** (`live === true &&
   kind === 'interactive'`), bypassable in principle by type juggling on a
   hand-crafted body, and it didn't cover a live *background* session
   missing its `id` (which would silently fall through to the unsafe
   `--resume` template instead of refusing). Replaced with an allowlist:
   a live session is only ever actioned if it is `kind === 'background'`
   **and** has a non-empty `id` (the one proven-safe case — `claude attach
   <id>`); every other live session, for any reason, is refused. This also
   makes the check immune to the body no longer being trusted for these
   fields in the first place, since `live`/`kind`/`id` are now the
   server's own values.

**Hardening, round 2, part 2 — origin/host checks:** the endpoint had no
`Origin`/`Host` validation, so any web page open in the same browser while
the dashboard is running could POST to it (a same-origin-policy gap, not a
CORS one — simple cross-origin POSTs aren't blocked by browsers on the
request side, only the response). Even with the round-2 fixes above
closing the dangerous outcomes, an uninvited page silently triggering a
real (if safe) resume, or reading session names/previews via a cross-
origin `GET /api/sessions`, is not acceptable for a tool with no auth
layer. Fixed: reject (`403`) any request whose `Host` header isn't
`127.0.0.1:<port>` or `localhost:<port>` (blocks DNS-rebinding), and reject
any request whose `Origin` header is present and doesn't match the same
allowlist (blocks ordinary cross-origin script access; a request with no
`Origin` header at all — e.g. curl, or same-origin navigation — is
allowed, matching how a purely local tool should behave). `POST
/api/resume` additionally requires `Content-Type: application/json`,
which forces a CORS preflight for any cross-origin caller and gives the
`Origin` check a chance to run before the browser would otherwise treat
the request as "simple."

### `POST /api/purge` (added 2026-09-09)

Body: `{ "sessionId": "<the session's id>" }` — same server-side
resolve-by-id pattern as `POST /api/resume`; nothing else from the body is
trusted.

**Purges by moving to a trash folder, never a real delete.** Moves the
session's transcript (and its companion directory, if Claude Code created
one alongside the `.jsonl`) from `<SESSIONS_ROOT>\projects\<encoded-cwd>\`
into `<SESSIONS_ROOT>\.resumeragent-trash\<encoded-cwd>\` — an
`fs.rename`, not a delete. This is deliberately reversible: move the
folder back to undo it, or empty `.resumeragent-trash` yourself once
you're sure. The session disappears from the dashboard immediately (the
next discovery scan no longer finds it under `projects/`), which is the
actual goal — decluttering — without the risk of an irreversible mistake.
See `lib/purgeSession.mjs`.

**Safety, stricter than resume, not looser:** resuming allows one narrow
exception for live sessions (`kind === 'background'` with an `id` —
`claude attach`, a view, never a resume). Purging has no such exception —
`session.liveUnknown || session.live` is refused outright, full stop,
regardless of kind. There is no safe analog to "attach" for moving a
session's files out from under it, so this check doesn't need to be an
allowlist of exceptions; it's a flat refusal of anything not confirmed
dead. Same `409` (liveness unknown) vs `400` (confirmed live) distinction
as the resume guard.

**Client-side confirmation:** a "Delete" button appears only on cards
that are confirmed dead (mirrors the server's own gate — never rendered
at all for a live or liveUnknown session, not just disabled). Requires
two clicks: the first arms a 5-second confirmation window and relabels the
button "Click again to confirm"; a second click within that window
actually fires the request. The button is briefly disabled right after
the first click so a fast accidental double-click can't land both clicks
before a person could realistically react to the label change. This was
a deliberate choice over a type-the-name confirmation, made explicitly by
the user weighing convenience against the (already well-mitigated, given
the trash-not-delete model) risk of a mistaken purge.

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
  timestamp — reflecting the timestamp of the last *successful* fetch, not
  "now" (an earlier version computed `relativeTime(Date.now())` at render
  time, which is always "just now" by construction and silently hid a
  stale feed; fixed to store and reuse the actual fetch time).
- Responsive card grid (`repeat(auto-fill, minmax(300px, 1fr))`), one card
  per session: name (bold), status pill, `cwd` in monospace
  (ellipsis-truncated, full path on hover), relative last-active time,
  italic one-line preview (2-line clamp), kind badge, primary action button
  (Resume for dead sessions / Attach for live background sessions /
  disabled "Already open elsewhere" for live interactive sessions /
  disabled "Status unknown" when liveness couldn't be confirmed — see
  Hardening under `POST /api/resume`).
- No Stop button. It was in an earlier draft of this section but never
  implemented or broken into a task; given everything this project has
  already been through around spawning processes, adding a second
  process-affecting endpoint (`/api/stop`) isn't worth it for a "nice to
  have" — struck here so the spec matches the code.

**Motion** (respecting `prefers-reduced-motion: reduce`)
- Cards fade + slide up on load, staggered ~30ms per card.
- Card hover: lift (`translateY(-2px)`) + soft shadow, ~150ms ease-out.
- Live-status pill: slow soft pulse (opacity 0.85↔1, ~2s loop).
- Button press: slight scale-down (`0.97`) on `:active`.
- Resume/Attach click: inline spinner, then an auto-dismissing toast
  ("Opening terminal for PHOENIX-18579…").

**States**
- Loading: skeleton cards, not a blank screen — removed from the DOM once
  the first real payload renders (an earlier version left them in
  permanently on the happy path; fixed).
- Empty: "No sessions found yet."
- Error (`/api/sessions` fetch fails): inline banner with Retry on the
  *first* load — never a blank page. On any later poll failure (once
  cards are already showing), the header timestamp switches to a "stale ·
  last updated …" label instead of silently continuing to say "just
  now" — a poll failure must be visible, not invisible, since acting on
  stale liveness data is exactly the kind of mistake this project is
  trying to design out of itself.
- Keyboard: all buttons reachable by Tab with a visible focus ring.

**Polling:** re-fetch `/api/sessions` every 5s, diffing in place rather than
re-rendering the whole grid, so cards don't flicker or lose hover/focus
state on refresh.

## Safety

- Server binds explicitly to `127.0.0.1`, never `0.0.0.0`.
- No authentication layer — acceptable, local-only and single-user (each
  colleague runs their own instance against their own sessions) — but see
  the `Origin`/`Host` checks below, which are the actual thing standing
  between this tool and any other web page open in the same browser.
- `/api/resume` resolves `cwd`/`live`/`kind`/`id`/`name` itself by looking
  the session up (by the one field it does trust, `sessionId`) in its own
  fresh `GET /api/sessions` computation — it never trusts these fields as
  supplied in the request body. This is the actual load-bearing property;
  an earlier version trusted the body directly, which the final review
  caught as not actually enforcing the guard below.
- A live session is only ever actioned if it is `kind === 'background'`
  **and** has a non-empty `id` — the one case proven safe (`claude attach
  <id>`, a view, not a resume). Every other live session — interactive,
  or background with a missing `id` — is refused (`400`), full stop. This
  is an allowlist of the one safe case, not a blacklist of the one known-
  bad case, so it can't be bypassed by a session shape nobody's thought of
  yet.
- Liveness itself can fail to be determined (the `claude` CLI times out,
  isn't on PATH, or returns malformed output). This must never be treated
  as "therefore not live" — `readLiveAgents()` returns `null` (distinct
  from `[]`) on any failure, and any session whose liveness is unknown is
  refused by `/api/resume` (`409`) and shown as un-actionable in the UI,
  exactly like a confirmed-live interactive session. Fail closed, not open.
- The server only reads files under `SESSIONS_ROOT`, and only ever spawns
  the one whitelisted `cmd /k` pattern with fields sourced from its own
  server-side lookup — no arbitrary command execution from frontend input.
- Any free-text field (e.g. `name`) that ends up in a string later
  re-parsed by `cmd.exe` (the spawned window's title) is sanitized to
  `[A-Za-z0-9 _.-]` before use, including every fallback path through that
  sanitizer — `cmd.exe /c` re-parses its whole command line for its own
  metacharacters, so Node's argv quoting alone does not neutralize them,
  and a fallback that skips the filter reopens the same hole (this exact
  regression was caught and fixed in Task 9's second fix round).
- `POST /api/resume` and `GET /api/sessions` both reject (`403`) any
  request whose `Host` header isn't `127.0.0.1:<port>` or
  `localhost:<port>` (blocks DNS rebinding), and reject any request whose
  `Origin` header is present and doesn't match that same allowlist (a
  request with no `Origin` at all — curl, same-origin navigation — is
  allowed). `POST /api/resume` additionally requires `Content-Type:
  application/json`. Together these are what actually stop another web
  page open in the same browser from silently calling this API — binding
  to `127.0.0.1` alone only stops requests originating outside the
  machine, not from software already running on it.
- Both process-spawning calls (`spawn` for resume/attach, `exec` for the
  startup browser-open) attach an `'error'` listener — `spawn`/`exec`
  report launch failures asynchronously via an event that a surrounding
  try/catch cannot see, so without this an OS-level spawn failure (e.g.
  `cmd.exe` missing) would crash the whole server as an unhandled
  rejection, the same failure class the crash-safety fix already closed
  for malformed request bodies.
- The server never crashes the whole process on a malformed or
  wrong-shaped request body; `/api/resume` validates the parsed body is a
  non-null object with a string `sessionId` before use, and wraps the rest
  of its logic in try/catch.
- `.env` (holding any machine-specific overrides) is gitignored; only
  `.env.example` (documented placeholders, no real paths) is committed —
  relevant now that this is a shared repo, not a personal script. `.env`
  is actually loaded now — a zero-dependency ~15-line parser in
  `lib/config.mjs`, since no `dotenv`-style package is allowed and Node's
  own `--env-file` flag would tie the `package.json` `start` script to a
  specific Node version floor. Real environment variables still take
  precedence over `.env` values, matching the usual dotenv convention.
- **Windows only.** The spawn calls hardcode `cmd.exe`/`cmd /k`; a
  colleague on macOS/Linux cannot run this as-is regardless of
  `RESUME_COMMAND`/`ATTACH_COMMAND`, since the *outer* shell that opens a
  new terminal window is not configurable. The README says so explicitly.

## Distribution

- Repo: `C:\AE\ResumerAgent`, pushed to a **private** GitHub repo (session
  previews can reference internal ticket IDs/work, so kept private).
- Colleague usage: `git clone`, `npm install`, copy `.env.example` to
  `.env` and adjust `SESSIONS_ROOT`/`RESUME_COMMAND` if they're not on a
  native install with default paths, `npm start`. README documents this
  end to end, including the Docker override example above.

## Testing

- Manual: run `npm start` with the current 3-4 real sessions on this
  machine present; verify the dashboard lists them, preview text matches
  the last real user message, live status matches `claude agents --json`.
- Manual: kill one live session's process, confirm it drops out of `live`
  but keeps showing as `resumable`.
- **Rule for verifying anything that spawns a process (Resume/Attach):
  always use synthetic fake session data** — never a real session's ID,
  live or dead. Since `/api/resume` now resolves everything server-side
  from `sessionId`, a synthetic test either targets a `sessionId` that
  doesn't exist in the real session list (expect `404`) or exercises the
  pure `buildResumeCommand`/`sanitizeTitle` logic directly with fabricated
  session objects, as Tasks 7/8 already do — there is no need to target a
  real session to prove the plumbing works, and doing so risks real side
  effects (see the Hardening note under `POST /api/resume`). This rule
  binds every task and every future change to this project, not just
  Task 9.
- No automated test suite — single-user local utility; manual verification
  against synthetic/read-only data (never a live spawn against a real
  session) is the right bar.
