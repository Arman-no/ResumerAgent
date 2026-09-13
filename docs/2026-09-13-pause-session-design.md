# Pause a Live Session — Design

Date: 2026-09-13
Status: implemented (2026-09-13) — Pause built as designed, one bug fixed along
the way (see below). Extended same day with Close, an addendum at the end of
this doc, after real memory pressure on the dev machine (15.7GB total, ~725MB
truly available) made "no way to reclaim RAM from an interactive session"
worth actually solving instead of leaving as an explicit non-goal.
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

## Addendum (2026-09-13, same day): Close, for a live interactive session

`lib/closeSession.mjs` (tested in `lib/closeSession.test.mjs`); `server.mjs`
adds `canClose()` and `POST /api/close`; `public/app.js`/`styles.css` add the
Close (✕) icon button next to a live interactive row's disabled Resume
button, same two-click confirm as Pause/Purge via `handleConfirmClick()`.
`lib/mergeSessions.mjs` now also exposes `pid` on every merged session
(previously computed only for the internal `isPidAlive()` check) — Close
needs a real OS pid to act on, the way Pause needs a background job's `id`.

**Why this exists.** The Pause design above deliberately left Close out of
scope: "there is no external stop surface for an interactive session at
all." That's still true — nothing changed about what Claude Code exposes.
What changed is the cost of leaving it unsolved: a real memory check on the
dev machine mid-session found 15.7GB total RAM with only ~725MB truly
available (`Get-Counter '\Memory\Available MBytes'`, not the more
optimistic `Win32_OperatingSystem.FreePhysicalMemory`), with 42 live
node/claude processes totaling 6.8GB private memory across ~5 simultaneous
interactive sessions plus their own LSP/MCP helper processes. Pausing only
covers background jobs, which most of this user's sessions aren't — Close
is what actually lets the one lever that matters (ending sessions nobody's
using right now) be pulled from the dashboard instead of hunting down and
closing terminal windows by hand.

**What was tried and rejected, in order, all verified live against a real
disposable interactive session:**

1. **`GenerateConsoleCtrlEvent` (the standard signal-based Ctrl+C).**
   `AttachConsole` + `SetConsoleCtrlHandler` + two timed `CTRL_C_EVENT`s (to
   match Claude Code's own "press again to confirm" exit prompt) all
   reported success. The target process didn't budge.
2. **`WriteConsoleInput` (a raw Ctrl+C keystroke written into the console's
   input buffer, bypassing the signal system entirely).** Also reported
   success on both a down and up event, sent twice. Also no effect.
   `GetConsoleMode` on the target's console read `0x208` —
   `ENABLE_VIRTUAL_TERMINAL_INPUT` set, `ENABLE_PROCESSED_INPUT` /
   `ENABLE_LINE_INPUT` / `ENABLE_ECHO_INPUT` all off. Claude Code's
   interactive UI reads through a pseudo-console/raw-input layer that
   neither the classic signal path nor the classic input-buffer path
   reaches. There is no verified in-band way to ask it to exit from outside
   the process — this is a hard wall, not a tuning problem.
3. **A direct process kill, but only the top-level pid.** Rejected once
   traced live: an interactive session's `claude.exe` spawns its own
   LSP/MCP helper processes (pyright, the ruflo MCP server, Playwright's
   MCP server) as real descendants several process-levels deep through
   intermediate `cmd.exe`/`node.exe` launcher wrappers — confirmed by
   walking `Win32_Process.ParentProcessId` chains for real running
   sessions on this machine. A single-pid kill leaves that entire tree
   orphaned and still consuming memory, defeating the actual point of
   Close. Two independent live test-and-kill runs each surfaced **4
   separate descendant trees**, several levels deep, for a session barely
   a few seconds old.

**What Close actually does:** `taskkill /PID <pid> /T /F` — `/T` (tree)
ends the target and every descendant, and never touches ancestors, so the
session's own parent `cmd.exe` window is untouched. Verified live that the
surviving window stays usable: `GetConsoleMode` on that console read back
normal cooked-mode flags (echo, line input, processed input all restored)
immediately after the child exited, with no manual `SetConsoleMode` fixup
needed — Windows/cmd.exe already resets it on its own once its child
process is gone.

**Safety.** `canClose(session)` mirrors `canPause`'s guard ordering
(`liveUnknown` → `superseded` → `live`) but inverts the kind check — the
one case `canSafelyAct` always refuses. `closeInteractiveSession()` also
re-verifies the target is still a real `claude.exe` process (via
`tasklist /FI "PID eq <pid>"`) immediately before acting, guarding against
PID reuse specifically — the server already re-derives session state fresh
per the established pattern, but killing a silently-recycled PID has no
safe undo, unlike every other action in this app.

**A real bug this surfaced, on top of the PID-reuse guard:** `taskkill /T`
fails its *overall* exit code if any single descendant can't be
terminated — including one that already exited on its own between
enumeration and the kill attempt. Confirmed live: a real helper process
raced this way ("no running instance of the task" for one specific child),
even though the actual target pid was already gone — the real goal had
already been reached. Fixed by re-checking the target pid specifically
after a `taskkill` failure and only surfacing the error if the target
itself is still running; a descendant losing that race is not a failure.
Covered by `lib/closeSession.test.mjs`.

**What wasn't built:** no attempt at a gentler close (see the rejected
list above — there isn't one to reach for), and no change to Pause's own
scope — a live background job still goes through `claude stop`, never
through Close's tree-kill, since the gentler native path exists for it.

## Second addendum (2026-09-13, same day): mouse-tracking corruption after Close

Reported by the user after using Close on a real session: the surviving
terminal echoed raw xterm SGR mouse-report escape codes
(`ESC[<Cb;Cx;CyM`) on every mouse movement, permanently, until the window
was closed and reopened — "it's like something that exists across Claude
Code itself... it happened before too."

**Root cause.** The classic console input-mode flags (echo, line input,
processed input) reset on their own once a child process exits — already
confirmed live in the main addendum above. VT-level modes are a different
layer: the session's TUI enables mouse tracking for its own UI via a
private-mode escape sequence, and normally disables it again as part of
its own exit cleanup. A force-ended process never runs that cleanup, and
Windows does not auto-clear VT modes the way it does the classic flags —
so the parent terminal is left reporting every mouse move as raw escape
bytes indefinitely. Genuinely upstream in how Windows/ConPTY handles an
abruptly-ended VT-mode application, not specific to Close, but Close is
what makes it reliably reproducible on demand.

**Fix.** `scripts/reset-terminal-modes.ps1`, called from
`closeInteractiveSession()` after a successful kill: attaches to the
**parent's** console (looked up via `Get-CimInstance` *before* the kill —
the target pid can't be asked "what was your parent" once it's gone) and
writes the standard xterm disable sequences for every common
mouse-tracking variant (1000/1002/1003 report modes, 1006/1015
coordinate encodings), bracketed paste (2004), and the alternate screen
buffer (1049), ending with a full VT reset (RIS, `ESC c`) as a catch-all.
Best-effort by design — the close itself already succeeded regardless of
this step, so a failure here (parent pid not found, `AttachConsole`
failing) is logged and swallowed, never surfaced as a failed close.

**Verification, and its honest limit (as first shipped).** The real
script was run against a real live console after a real Close and exited
clean (0) — confirmed the Win32 calls succeed end-to-end, not a guess.
What wasn't achieved at the time: a fully automated "simulate real mouse
movement, read the console buffer, confirm zero garbage" loop —
`GetWindowRect` returned a degenerate rect in the test environment, and
chasing that down further didn't seem proportionate. **This turned out to
matter**, see below.

## Third addendum (2026-09-13, same day): the fix above was incomplete

Direct user report after actually using Close in practice: typed
characters plus Enter came through clean, but arrow keys and mouse
movement still produced garbage. The exact gap the honest-limit note
above flagged — output-stream verification isn't the same as confirming
the actual symptom is gone, and it wasn't.

**Root cause, this time nailed down with a real before/after measurement
instead of trusting an exit code.** The second addendum's fix only wrote
xterm private-mode *disable sequences* to the console's output stream.
That's one layer. A completely separate layer — `ENABLE_VIRTUAL_TERMINAL_INPUT`
(`0x0200`), a classic Win32 **input**-mode flag set via `SetConsoleMode`,
not an output escape sequence — controls whether arrow keys, function
keys, and mouse events arrive as raw VT escape bytes at all, independent
of which specific xterm private modes are negotiated. Measured directly:
closed a real test session with only the second addendum's fix applied,
then read the surviving console's input mode via `GetConsoleMode` —
`0x20F`, meaning `ENABLE_VIRTUAL_TERMINAL_INPUT` was still on. The first
addendum's claim that "Windows resets the classic input flags on its own"
turned out not to be reliable either — a second measurement of that same
"auto-recovery" produced a *different* partial state each time (`0x1F7`
once, `0x20F` another time), never guaranteed to include clearing this
specific bit.

**Fix.** `scripts/reset-terminal-modes.ps1` now also calls
`SetConsoleMode` on the parent console's input handle directly, forcing
it to the known-good baseline (`ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT
| ENABLE_ECHO_INPUT | ENABLE_MOUSE_INPUT | ENABLE_INSERT_MODE |
ENABLE_QUICK_EDIT_MODE | ENABLE_EXTENDED_FLAGS | ENABLE_AUTO_POSITION`,
i.e. `0x1F7`) rather than trusting Windows to get there on its own. Runs
alongside the existing output-stream disable sequences — both are needed,
neither substitutes for the other.

**Verification, done properly this time.** Measured the exact broken
state on a real console (`0x20F`, confirmed), ran the updated script
directly against that same real console, re-measured: `0x1F7`,
`ENABLE_VIRTUAL_TERMINAL_INPUT` confirmed cleared. A real before/after on
the actual bit that was causing the reported symptom, not an exit code
standing in for a claim about behavior.
