# Agent Setup Guide — read this if you are a Claude Code agent installing ResumerAgent

You are being handed this repo on a machine you've never worked on before. This
file is written as instructions *to you*, not prose for a human — follow it in
order, run the commands, and use the troubleshooting table to self-diagnose
instead of asking the user what to do first.

## What this is

A local Windows dashboard that finds and resumes dead/live Claude Code CLI
sessions — plus a per-session expiry warning and an activity/observability
panel (cost, context-window %, optional rate limits) and a dark/light
themed UI. Branch `master` is feature-complete — do not work from any
other branch unless the user tells you to. Don't re-derive any of that
from first principles: `docs/*-design.md` has the design history and final
shipped state per feature, and `MASTER.md` at the repo root is the design
system (colors, type, spacing) — read those instead of guessing, and
**if you're touching `public/styles.css` or any UI, read `MASTER.md`
first.**

## Prerequisites — check before you install

1. **Windows.** Run `ver` or check `$OS`/`process.platform`. If this is
   macOS/Linux, stop and tell the user: Resume/Attach hardcode `cmd.exe`, this
   tool does not work there as-is.
2. **Node.js 18+.** Run `node --version`. If missing or too old, tell the user
   to install Node — do not try to install Node yourself via a package
   manager that might not be permitted on their machine (see AppLocker note
   below).
3. **`claude` CLI on PATH.** Run `claude --version`. If missing, the app still
   installs and runs, but the live-session overlay and the Resume/Attach
   commands themselves won't work — tell the user, don't silently proceed as
   if it's fine.
4. **Package manager: ask, don't assume.** This project has zero runtime
   dependencies, so `npm` (ships with Node, zero setup) and `pnpm` (if the
   user has it, via Corepack) both work equally well for every command
   below — just use whichever one the user actually has/prefers, swapping
   `npm` for `pnpm` throughout. If `pnpm install`/`corepack prepare` fails
   with `This program is blocked by group policy`, that's AppLocker — see
   the troubleshooting table below for the fix, don't just silently fall
   back to `npm` without telling the user, since they may specifically want
   pnpm.

## Install

Run these from the repo root, in order (shown with `npm`; substitute `pnpm`
throughout if that's the user's package manager):

```
npm install
copy .env.example .env
npm start
```

(`copy` is Windows `cmd.exe`; use `cp` if you're in a bash-like shell instead.)

This starts the server at `http://127.0.0.1:4317` and opens it in the
default browser. If nothing opens automatically, open that URL yourself and
check for a rendered session list — that's your verification the install
worked. `Ctrl+C` stops it.

## If the user wants a desktop shortcut

Point it at `npm run launch` — **specifically `npm`, even if the user
normally uses `pnpm` everywhere else, and even if `pnpm run launch`**
runs the identical underlying script. Two independent reasons, both real:

1. `launch` kills any previous instance already bound to the port before
   starting a fresh one — plain `start` (either package manager) silently
   leaves an old instance running if one exists, so the user ends up
   looking at stale code. See `README.md` for the full explanation.
2. A shortcut's child process inherits its environment from `explorer.exe`,
   which only re-reads the registry when it itself restarts (logoff/reboot,
   or a manual `explorer.exe` restart) — not on every new process it spawns.
   If the user set `COREPACK_HOME` via `setx` to work around AppLocker
   (see the troubleshooting table) *after* their current Explorer session
   started, a shortcut invoking `pnpm` will still fail to see that variable
   and hit the AppLocker block again, even though a freshly-opened terminal
   window picks it up fine. `npm` needs no such variable, so it's immune to
   this staleness — that's the actual reason to prefer it for a shortcut
   specifically, not a blanket "don't use pnpm."

## Troubleshooting — match the symptom, apply the fix, don't guess

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm install` or `corepack prepare` fails with `This program is blocked by group policy` | Corporate AppLocker blocks unsigned `.exe` outside an allow-listed directory tree; corepack's default pnpm install path is outside it | Don't fight AppLocker. Either just use `npm` (this project has zero runtime dependencies, npm is all it needs), or if the user specifically wants pnpm: `setx COREPACK_HOME "<a directory under the machine's AppLocker allow-list>"`, open a new shell, retry `pnpm install`. |
| Dashboard loads but the session list is empty or wrong, even though the user has real Claude Code sessions | `SESSIONS_ROOT` resolved to the wrong directory. It defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude` — but `CLAUDE_CONFIG_DIR` is often only set *inside* a shell launched from a Claude Code session's own process tree, not from a plain double-clicked shortcut or a fresh terminal, so it silently falls back to the wrong default | Find the real sessions directory (ask the user, or look for a folder containing a `sessions/` subfolder with `<pid>.json` files and a `projects/` subfolder with `.jsonl` transcripts). Set `SESSIONS_ROOT=<that path>` explicitly in `.env` — don't rely on the ambient env var. |
| `EADDRINUSE` / "already running" message on `npm start` | Something's already bound to port 4317 — could be a genuinely-still-running previous instance | Use `npm run launch` instead (kills the old one first), or set a different `PORT` in `.env` if the user wants both running. |
| Resume/Attach opens a `cmd.exe` window but it errors with "The filename, directory name, or volume label syntax is incorrect" | A `RESUME_COMMAND`/`ATTACH_COMMAND` override in `.env` has quoting that doesn't survive nested `cmd.exe` parsing | Don't hand-edit the spawn logic to patch around it. Check `.env` for a custom command template first — the shipped defaults (`lib/config.mjs`) are already the fixed version; a leftover custom override from an older `.env` is the usual cause. |
| Resumed session's terminal shows the wrong session name entirely, or an unrelated Claude session's name changes | Environment-variable identity leak into the spawned process, OR (rarer, see hard rule below) process-ancestry contamination | Confirm `lib/cleanEnv.mjs` is being used by every `spawn`/`exec` call in `server.mjs` and `lib/liveAgents.mjs` — it should already be wired in on `master`. If you changed something and this regressed, that's the file to check first. If it's not an env issue, see the hard rule below before doing anything else. |
| Dashboard loads, lists sessions, but every row is stuck "Status unknown" with every button disabled | `readLiveAgents()` (`lib/liveAgents.mjs`) failed — check the server's own console output, not the browser. It now logs whether `claude` is missing from PATH vs. some other failure (wrong CLI version too old to support `agents --json --all`, a timeout, EDR/AppLocker blocking the `claude` process itself). `claude agents --json --all` cost scales with tracked-session count (measured 2.2–6.3s with ~8–11 sessions on a real machine), which is why its timeout is already 15s, not 5s — don't "fix" a timeout by raising it further without checking whether something else is actually hanging. | Run `claude --version` and `claude agents --json --all` directly in the same shell the server runs in — whatever that fails with is the real cause; fix that, don't touch the merge/safety logic. |
| Resume opens nothing, but the dashboard still says it succeeded | Older code returned `ok:true` before confirming the spawn actually started, so a blocked `cmd.exe`/`start` (AppLocker/EDR on this user) looked like success. `master` now waits briefly for the spawn's own error event before responding. | If you still see this, check the server console for "Failed to spawn resume terminal" — that's the real error the UI should now also be surfacing. |
| A session row's activity strip never shows rate-limit numbers (5h/7d), even though cost/context data appears fine | Not a bug. Rate limits have no transcript representation at all — they come exclusively from an optional statusline-sidecar file (`lib/activitySidecar.mjs`, `<SESSIONS_ROOT>/activity/<sessionId>.json`), written by the user's own statusline script. Most installs don't have one configured. | Confirm with the user whether they have a statusline sidecar writer set up. If not, this is expected — don't add a transcript-parsing workaround for rate limits, `docs/2026-09-12-activity-observability-design.md` already confirmed there's no such data to parse. |
| A live session never shows a Pause button, even though it's clearly running | Not a bug. Pause only exists for a **background** job (`claude --bg`, has a stoppable `id`) — an interactive session is a terminal someone has open, and Claude Code has no external stop surface for that at all (confirmed via `claude --help`: `stop|kill <id>` only ever documents a background session). | Check `kind` in `/api/sessions` for that session. If it's `interactive`, this is expected — don't add a kill-by-PID fallback for it, see `docs/2026-09-13-pause-session-design.md` for why that was rejected. |
| After a Pause succeeds, `claude agents --json --all` still lists the session (now with a `state` key) and it briefly looked "live" on the dashboard | Fixed on `master` (`lib/mergeSessions.mjs`) — a terminal-state entry (`state` present at all: observed values include `done` and `failed`) is now excluded from the live set outright, not just deprioritized against a live companion entry. If you see this again, the regression is almost certainly a change to that filter. | Run the two `mergeSessions.test.mjs` cases for `done`/`failed`-only entries before touching this file again; don't re-add a check for one specific `state` string, the fix is deliberately "any `state` key at all," since the CLI's exact terminal-state vocabulary isn't fully documented. |

## Hard rules — do not violate these even if it seems like it would help

1. **Never relaunch this project's own dev server via your own shell tool from
   inside the same Claude Code session you're using to develop/fix it.**
   Doing this repeatedly on the original development machine made the server
   process a *descendant* of the calling session's own process tree. Claude
   Code's session-naming/collision system tracks OS-level process ancestry,
   not just environment variables — this caused a live, unrelated, important
   session's name to get silently overwritten mid-conversation, with no
   available code-level fix. If this server needs restarting while you're
   working on it, ask the user to do it themselves from a separate, clean
   terminal.
2. **Never test `/api/resume` or `/api/purge` against real session data.**
   Both actions spawn processes or move files. Use synthetic `.jsonl`
   fixtures written with a file-write tool (not a shell heredoc — heredocs
   have a known history of mangling backslashes in Windows paths).
3. **Don't add a new dependency to solve something `node:http`/`node:fs`/
   `node:child_process` already does.** This project is deliberately
   zero-runtime-dependency; that's why `npm` alone is sufficient and there's
   no lockfile drift to manage. Keep it that way unless the user explicitly
   asks for a library.

## Done criteria

You're finished when: `npm start`/`pnpm start` (or `npm run launch`) runs without error,
the dashboard loads in a browser at `http://127.0.0.1:4317`, and it shows at
least one real session from the user's actual `SESSIONS_ROOT`. If any of
those three isn't true, you are not done — work the troubleshooting table
above before reporting success.
