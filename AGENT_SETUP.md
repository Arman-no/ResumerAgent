# Agent Setup Guide — read this if you are a Claude Code agent installing ResumerAgent

You are being handed this repo on a machine you've never worked on before. This
file is written as instructions *to you*, not prose for a human — follow it in
order, run the commands, and use the troubleshooting table to self-diagnose
instead of asking the user what to do first.

## What this is

A local Windows dashboard that finds and resumes dead/live Claude Code CLI
sessions. Branch `master` is feature-complete — do not work from any other
branch unless the user tells you to.

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

## Install

Run these from the repo root, in order:

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

Point it at `npm run launch`, **not** `npm start` or `pnpm start`. `launch`
kills any previous instance already bound to the port before starting a
fresh one — plain `start` silently leaves an old instance running if one
exists, so the user ends up looking at stale code. See `README.md` for why.

## Troubleshooting — match the symptom, apply the fix, don't guess

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm install` or `corepack prepare` fails with `This program is blocked by group policy` | Corporate AppLocker blocks unsigned `.exe` outside an allow-listed directory tree; corepack's default pnpm install path is outside it | Don't fight AppLocker. Either just use `npm` (this project has zero runtime dependencies, npm is all it needs), or if the user specifically wants pnpm: `setx COREPACK_HOME "<a directory under the machine's AppLocker allow-list>"`, open a new shell, retry `pnpm install`. |
| Dashboard loads but the session list is empty or wrong, even though the user has real Claude Code sessions | `SESSIONS_ROOT` resolved to the wrong directory. It defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude` — but `CLAUDE_CONFIG_DIR` is often only set *inside* a shell launched from a Claude Code session's own process tree, not from a plain double-clicked shortcut or a fresh terminal, so it silently falls back to the wrong default | Find the real sessions directory (ask the user, or look for a folder containing a `sessions/` subfolder with `<pid>.json` files and a `projects/` subfolder with `.jsonl` transcripts). Set `SESSIONS_ROOT=<that path>` explicitly in `.env` — don't rely on the ambient env var. |
| `EADDRINUSE` / "already running" message on `npm start` | Something's already bound to port 4317 — could be a genuinely-still-running previous instance | Use `npm run launch` instead (kills the old one first), or set a different `PORT` in `.env` if the user wants both running. |
| Resume/Attach opens a `cmd.exe` window but it errors with "The filename, directory name, or volume label syntax is incorrect" | A `RESUME_COMMAND`/`ATTACH_COMMAND` override in `.env` has quoting that doesn't survive nested `cmd.exe` parsing | Don't hand-edit the spawn logic to patch around it. Check `.env` for a custom command template first — the shipped defaults (`lib/config.mjs`) are already the fixed version; a leftover custom override from an older `.env` is the usual cause. |
| Resumed session's terminal shows the wrong session name entirely, or an unrelated Claude session's name changes | Environment-variable identity leak into the spawned process, OR (rarer, see hard rule below) process-ancestry contamination | Confirm `lib/cleanEnv.mjs` is being used by every `spawn`/`exec` call in `server.mjs` and `lib/liveAgents.mjs` — it should already be wired in on `master`. If you changed something and this regressed, that's the file to check first. If it's not an env issue, see the hard rule below before doing anything else. |

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

You're finished when: `npm start` (or `npm run launch`) runs without error,
the dashboard loads in a browser at `http://127.0.0.1:4317`, and it shows at
least one real session from the user's actual `SESSIONS_ROOT`. If any of
those three isn't true, you are not done — work the troubleshooting table
above before reporting success.
