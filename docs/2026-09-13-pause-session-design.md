# Pause a Live Session — Design

Date: 2026-09-13
Status: implemented (2026-09-13) — built as designed, one bug fixed along the way (see below).
`lib/pauseSession.mjs` wraps `claude stop <id>` (tested in `lib/pauseSession.test.mjs`);
`server.mjs` adds `canPause()` and `POST /api/pause`; `public/app.js`/`styles.css`
add the Pause icon button (two-click confirm, same mechanism as Purge, factored
into a shared `handleConfirmClick()`).
Repo: `ResumerAgent`

## Problem

The user asked for a Pause button per session: stop a session's active work,
but keep it resumable exactly where it left off — the practical meaning of
"pause" for something that isn't actually a process with a suspend/resume
primitive.

## What "pause" can safely mean here

Claude Code sessions come in two shapes, and they don't have the same answer:

- **Background** (`claude --bg`) — has a stoppable id. Claude Code ships a
  native `claude stop|kill <id>` command for exactly this:
  > "Stop a background session. Its conversation is kept: `claude attach
  > <id>` opens it again, `claude --resume` works once it is stopped."
  (`claude --help`, verified live 2026-09-13). This is real pause/resume,
  not a workaround — the conversation is kept by Claude Code's own design,
  the same way it already survives any other clean or unclean exit.
- **Interactive** — is a terminal someone has open. There is no `claude`
  subcommand that stops an interactive session from outside it, and no
  reason to expect one: it would mean one session (or this dashboard)
  reaching in and killing a terminal a person is actively looking at.
  `claude --help` confirms `stop|kill <id>` only ever documents a
  background session.

So Pause only exists for a live background job. That's not a scoped-down
compromise — it's the one case where a real, already-safe mechanism exists.

### Rejected: killing the process by PID ourselves

The registry already carries a `pid` (used by `mergeSessions.mjs`'s
`isPidAlive()` fail-closed check), so an OS-level `process.kill(pid, ...)`
was considered and rejected:

- On Windows, `process.kill` with any signal other than `0` unconditionally
  force-terminates — there is no real suspend/resume signal to send, so
  this would already be no gentler than `claude stop`.
- It reinvents a lifecycle operation Claude Code already owns and has
  already gotten right (conversation preservation, resumability). Using
  `claude stop <id>` means this app never has to reason about *how* a
  session shuts down safely — that's exactly the boundary `resumeCommand.mjs`
  already draws for Resume/Attach (build the right `claude` invocation,
  never reimplement what it does).
- PID reuse is a real hazard on Windows (long-running dashboard, PIDs
  recycle) that a native `<id>`-addressed command sidesteps entirely.

## Safety gating

`canPause(session)` in `server.mjs` is `session.live && canSafelyAct(session)`
— it reuses the exact allowlist Attach already requires
(`!liveUnknown && !superseded && kind === 'background' && typeof id ===
'string' && id.length > 0`) rather than re-deriving a parallel one. An
interactive live session always fails `kind === 'background'` and so can
never be paused, by construction, not by a special case.

`/api/pause` follows the same server-side-lookup pattern as `/api/resume`
and `/api/purge`: the request body's `sessionId` is only ever a key into a
fresh `getSessionsPayload()` call — nothing about liveness or kind is ever
trusted from the client.

## A real bug this surfaced: `mergeSessions.mjs` and terminal states

End-to-end verification (spawn a real disposable `claude --bg` job, pause it
through the actual dashboard UI) found that `claude agents --json --all`
keeps listing a background job after it's stopped — same sessionId, now
carrying a `state` key (`"done"` for a paused job; a second, unrelated real
job on this machine was independently found sitting at `state: "failed"`).
`mergeSessions.mjs` treated presence of *any* entry for a sessionId as
`live: true`, done or not — so a session this app itself just paused would
have kept reading as live, with Attach still offered for a process that no
longer existed. Its own comment already said "prefer whichever entry isn't
done," but a done-only entry (exactly what pausing produces) had never been
exercised before Pause existed to produce one on demand.

Fixed by skipping any live-agents entry with a `state` key present at all,
rather than checking for specific values — a running job carries no `state`
key in the same output, so its presence is Claude Code's own signal for "this
is a historical record," and enumerating known terminal strings (`done`,
`failed`, and whatever else exists that hasn't been observed) would be
guessing at a vocabulary this project doesn't control. Covered by two new
`mergeSessions.test.mjs` cases (a lone `done` entry, a lone `failed` entry —
both assert `live: false`).

## What wasn't built

- **No "paused" state distinct from "resumable."** Once stopped, a
  background job is just a normal dead, resumable session — same model
  Resume/Purge already use. Inventing a separate visual state for
  "resumable because it finished" vs. "resumable because it was paused"
  would be state this app doesn't actually have (Claude Code itself makes
  no such distinction), so the row simply drops out of `live` and gains
  Resume/Purge like any other dead session.
- **No optimistic local UI update.** Purge can update its row locally
  because it already knows the file move succeeded. Whether `claude
  agents` now reports a paused session as gone is real external state this
  client hasn't polled yet — `pauseSession()` in `app.js` triggers a real
  `refreshNow()` instead of guessing the new row shape.
