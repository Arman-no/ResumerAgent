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
- Node.js 18+ (npm ships with it — nothing else to install)
- Claude Code CLI (`claude`) reachable on PATH for the live-session overlay
  and for the resume/attach commands themselves

This project has no runtime dependencies (`node:http`, `node:fs`,
`node:child_process` only), so plain `npm` is all it needs. `pnpm` works
too if you have it, but isn't required — and on a corporate-managed
Windows machine, `corepack`'s pnpm install can fail with `This program is
blocked by group policy`, since it downloads and runs an unsigned native
binary. That's an IT policy decision, not something to work around here;
just use `npm`.

## Setup

```bash
npm install   # no-op: nothing to install, just confirms Node works
cp .env.example .env   # optional — only needed if your setup isn't a default native install
npm start
```

This starts a server on `http://127.0.0.1:4317` and opens it in your
browser. `Ctrl+C` to stop; nothing runs when you're not using it.

**Desktop shortcut:** if you double-click a shortcut to launch this instead
of running the command yourself, point it at `npm run launch` rather than
`npm start`/`pnpm start`. `launch` first stops any previous ResumerAgent
instance still bound to the port before starting a fresh one, so you're
always looking at whatever code is currently on disk — plain `start` will
silently keep an old instance running if one is already there. Either way,
if a browser tab was already open before you relaunched, reload it — a tab
never re-fetches its own already-loaded JavaScript on its own, though it
will show a banner prompting you to reload once it notices the server
restarted.

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
  live or dead) and the session registry (`sessions/<pid>.json`, the
  source of truth for interactive liveness).
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
- Every `/api/resume` and `/api/purge` request re-derives the session's
  current state server-side from a fresh lookup; the client's request
  body is only ever a `sessionId` key, never trusted for anything
  safety-relevant.
- `superseded` sessions (see Features above) are refused for Resume —
  not because resuming an old session is unsafe, but because it's
  exactly the action that would grow a transcript you're trying to
  retire.

**Never test `/api/resume` or `/api/purge` against real session data** —
use synthetic `.jsonl` fixtures if you're changing this code.

### Architecture diagrams

Generated with the [archify](https://github.com/tt-a1i/archify) skill —
see `docs/diagrams/`.
