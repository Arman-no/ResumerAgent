# ResumerAgent

A small local dashboard for finding and resuming Claude Code sessions —
especially the ones that die when a terminal closes or the machine shuts
down and would otherwise be lost.

Claude Code already has `claude agents`, a terminal dashboard for every
*live* session across every directory. ResumerAgent covers what that
doesn't: dead interactive sessions, shown alongside the live ones, in a
browser, with one click to reopen a terminal on the right one.

**Handing this to a colleague, or to a Claude Code agent on another
machine?** Point them at `AGENT_SETUP.md` instead of this file — it's written
as install + self-troubleshooting instructions for an agent to follow
directly, including the machine-specific gotchas (AppLocker, `SESSIONS_ROOT`
detection) already hit once on the original dev machine.

## Requirements

- **Windows only.** Resume/Attach open a new terminal via `cmd.exe`,
  hardcoded — there's no cross-platform way to configure around this, so
  this tool doesn't run usefully on macOS/Linux as-is.
- Node.js 18+ (npm ships with it — nothing else to install)
- Claude Code CLI (`claude`) reachable on PATH for the live-session overlay
  and for the resume/attach commands themselves

This project has no runtime dependencies (`node:http`, `node:fs`,
`node:child_process` only), so plain `npm` needs zero setup. `pnpm` works
equally well if that's what you use — on a corporate-managed Windows
machine, `corepack`'s default pnpm install path can fail with `This
program is blocked by group policy` (AppLocker blocking an unsigned native
binary outside its allow-list), which isn't fixable from this project's
code, but is fixable on the machine: relocate it into an allow-listed
directory with `setx COREPACK_HOME "<allow-listed path>"`, open a new
shell, retry. See `AGENT_SETUP.md`'s troubleshooting table for the exact
steps.

## Setup

```bash
npm install   # no-op: nothing to install, just confirms Node works
cp .env.example .env   # optional — only needed if your setup isn't a default native install
npm start
```

This starts a server on `http://127.0.0.1:4317` and opens it in your
browser. `Ctrl+C` to stop; nothing runs when you're not using it.

**Desktop shortcut:** if you double-click a shortcut to launch this instead
of running the command yourself, point it at `npm run launch` — specifically
`npm`, even if you use `pnpm` for everything else. First: `launch` stops any
previous ResumerAgent instance still bound to the port before starting a
fresh one, so you're always looking at whatever code is currently on disk —
plain `start` (either package manager) will silently keep an old instance
running if one is already there. Second, if you're on pnpm because of the
`COREPACK_HOME` fix above: a shortcut's child process inherits its
environment from `explorer.exe`, which doesn't re-read the registry until it
itself restarts — so `setx COREPACK_HOME` only takes effect for *new
terminal windows*, not for an already-running Explorer's shortcuts, until
you log off/on. `npm` needs no such variable, so the shortcut stays
unaffected either way. Either way, if a browser tab was already open before
you relaunched, reload it — a tab never re-fetches its own already-loaded
JavaScript on its own, though it will show a banner prompting you to reload
once it notices the server restarted.

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

```
RESUME_COMMAND=docker exec -it my-claude-container claude --resume {sessionId}
ATTACH_COMMAND=docker exec -it my-claude-container claude attach {id}
```

## Features

- **Live + dead, one list.** Merges `claude agents --json --all` (live
  background jobs) with a scan of transcript `.jsonl` files (everything,
  live or dead) and the session registry (`sessions/<pid>.json`) — the
  registry is a secondary cross-check only, not the primary source: it's
  deleted on a normal clean exit, so `claude agents` is what actually
  decides `live`.
- **Sorting.** Sorted by created-at, newest first, by default; switchable
  from the toolbar.
- **No Name fallback.** A session with no `/rename` and no recoverable
  transcript title shows as "No Name" rather than a blank row — you can
  still tell them apart by cwd, last-message preview, and age.
- **Last message / recap preview.** Each row shows the last thing you
  actually typed, or the away-summary recap if Claude Code generated one.
- **Retired duplicates ("superseded").** If you rename a new session to
  the same name as an old, larger one you're done with, the old one is
  kept in the list (so you can still find and purge it) but marked
  "moved to a newer session" and its Resume button disabled — it can
  never be resumed by accident, and its transcript stops growing.
- **Fail-closed safety.** If liveness can't be confirmed, Resume/Attach/
  Purge are refused outright rather than guessed at. See "How it works"
  below for the full model.
- **Session expiry warning.** Claude Code silently deletes a session's
  transcript once it's older than `cleanupPeriodDays` (from
  `<SESSIONS_ROOT>/settings.json`, default 30 days, `0` = disabled). Any
  session within 5 days of that cutoff gets a `⚠ expires in Nd` badge,
  switching to `⚠ expires imminently` once it hits zero days left (a more
  urgent style kicks in at ≤1 day); everything else shows no badge at
  all — no visual noise until it's actually worth interrupting on. This is
  a warning only, not a guard — it can't stop or delay Claude Code's own
  cleanup, which runs independently at `claude` startup.
- **Dark/light theme.** Toggle button in the header, defaults to dark,
  persisted in `localStorage` and applied before first paint (no flash of
  the wrong theme). See `MASTER.md` for the full design system if you're
  touching any UI/CSS.
- **Pause a live background job.** A live *background* session (one
  started with `claude --bg`, the only kind with a stoppable id) gets a
  Pause button next to Attach, two-click confirm like Purge. It runs
  Claude Code's own `claude stop <id>` — not a process kill this app
  invented — so the conversation is kept exactly as `claude stop --help`
  documents: `claude attach <id>` or `claude --resume` both work again
  once it's stopped. There is no Pause for interactive sessions — those
  are a terminal someone has open, and Claude Code exposes no external
  stop surface for that at all. See
  `docs/2026-09-13-pause-session-design.md`.

## Activity panel

Above the session list, four headline stat cards (with a small inline
sparkline each) summarize everything the dashboard currently sees:
**Sessions tracked**, **Live now**, **Total cost**, **Avg context used**.
Honest caveat: only *Sessions tracked* has a real trend behind its
sparkline — a genuine 14-day daily count of new sessions, from each
session's own `createdAt`. This tool has never persisted a time-series of
its own aggregate stats, so *Live now*, *Total cost*, and *Avg context
used* are point-in-time snapshots recomputed on every poll; their
sparklines are honestly flat (a single current-value line) rather than a
fabricated trend. See `lib/statsSummary.mjs`.

Each session row also gets a small activity strip showing, when available:

- **Cost so far** and **context-window used %** (color-coded green/yellow/
  red at the same &lt;70 / 70–89 / ≥90 thresholds as this user's own
  statusline). Sourced by default from a backward tail-scan of the
  session's own transcript `.jsonl` — Claude Code writes its cumulative
  cost and per-turn token usage into the transcript itself
  (`lib/transcriptPreview.mjs`), with context-window size derived per the
  turn's own model (1M for current-generation models, 200k for everything
  else) so a real 1M-context session doesn't read as a false 100%.
- **Rate limits** (5h / 7d used %, with an "as of" freshness note) — these
  come from **one place only**: an optional statusline sidecar JSON file
  at `<SESSIONS_ROOT>/activity/<sessionId>.json`, written by your own
  `statusline.ps1` (or equivalent) on every statusline refresh
  (`lib/activitySidecar.mjs`). There is no transcript equivalent for
  rate-limit data — Claude Code only ever computes it for the statusline.
  Where both the sidecar and the transcript scan have a value (cost,
  context %), the sidecar's wins, since it's fresher and also covers a
  live session that hasn't hit a transcript checkpoint yet.
- If neither source has anything yet, the strip just says so
  (`no recent activity data`) rather than showing a blank or a misleading
  zero. **The sidecar is entirely optional** — most installs won't have
  one, and the dashboard degrades gracefully with no rate-limit data and
  transcript-only cost/context in that case, not an error.

## How it works

See `docs/2026-09-09-session-dashboard-design.md` for the full design
history — it grew through many small revisions as real bugs were found,
and explains the *why* behind each check below, not just the *what*.

Short version: it reads Claude Code's own per-session registry files plus
`claude agents --json --all`, merges them, and shows one dashboard.

### Safety model

- `liveUnknown` sessions (liveness couldn't be determined) are refused
  for every action, both client-side (button disabled, no click handler)
  and server-side (`canSafelyAct()` in `server.mjs`) — independently, so
  a bug in one layer doesn't silently rely on the other.
- Every `/api/resume`, `/api/purge`, and `/api/pause` request re-derives
  the session's current state server-side from a fresh lookup; the
  client's request body is only ever a `sessionId` key, never trusted for
  anything safety-relevant.
- `superseded` sessions (see Features above) are refused for Resume —
  not because resuming an old session is unsafe, but because it's
  exactly the action that would grow a transcript you're trying to
  retire.
- `/api/pause` reuses the same `canSafelyAct()` allowlist Attach already
  requires (live, not `liveUnknown`, not `superseded`, `kind ===
  'background'`, a real `id`) — see
  `docs/2026-09-13-pause-session-design.md` for why an interactive
  session can never satisfy it.

**Never test `/api/resume`, `/api/purge`, or `/api/pause` against real
session data you care about** — use synthetic `.jsonl` fixtures, or (for
pause, verified 2026-09-13) a disposable `claude --bg` job you don't mind
stopping, never a real one.

### Architecture diagrams

Generated with the [archify](https://github.com/tt-a1i/archify) skill —
see `docs/diagrams/`. **Stale as of 2026-09-13**: they predate the
activity panel, expiry warning, MASTER.md design system, and the pause
feature (last content match is `lib/liveAgents.mjs`, from the 2026-09-09
build). Regenerate with the archify skill next time it's installed
somewhere with access to this repo — it wasn't available in the session
that did this round of work, and hand-editing a generated diagram file
isn't a safe substitute.

### Design system

`MASTER.md` at the repo root is the single source of truth for this app's
visual and interaction design — color tokens (dark/light), typography,
spacing/radius scale, and the rules behind them (e.g. accent color is
spent once, on chrome only, never on status; status always uses
success/warning/critical). Read it before touching `public/styles.css` or
adding any UI — don't reintroduce a one-off hex value or re-derive a rule
it already settled.
