# Design: configurable cwd path style + liveness command for Docker-based `claude`

**Status:** approved, not yet implemented
**Date:** 2026-09-10

## Motivation

Asked whether a colleague whose only access to Claude Code is through a Docker
container could install and use ResumerAgent. Checked a real container setup
(`C:\AE\scripte\swiss-claude-cli`, not a hypothetical one) and found three
gaps:

1. `SESSIONS_ROOT` can't see into a container whose `.claude` directory is a
   named Docker volume rather than a host bind-mount.
2. `{cwd}` in `RESUME_COMMAND`/`ATTACH_COMMAND` is substituted as the raw
   Windows path ResumerAgent read from the transcript, but a command that
   execs into a container/WSL (e.g. `docker exec -w {cwd} ...`) needs that
   path in the container's own path format, not the host's.
3. `claude agents --json --all` runs on the host — a session actually
   running inside a container is invisible to it, so it would always read as
   "dead/resumable", never "live". That's the exact double-resume collision
   class this project exists to prevent.

Scoping decision (made with the user before this design): fix (2) and (3)
generically in ResumerAgent itself, for any docker/WSL-based colleague whose
setup already satisfies (1) (a bind-mounted `.claude`) and already has some
way to run `claude --resume`/`claude attach` inside their container. (1)
itself — and wiring up this specific swiss-claude-cli container end to end,
which would mean changing a shared, AWS-billed docker-compose stack — is
explicitly **out of scope** for this design. See "Non-goals" below.

## Scope

In scope:
- A configurable path-style transform applied to `{cwd}` before it's
  substituted into `RESUME_COMMAND`/`ATTACH_COMMAND`.
- A configurable command for the liveness check, so a docker-based colleague
  can point it at their container instead of the host.
- Documentation: a Docker requirements checklist and a worked WSL2 example.

Out of scope (non-goals):
- Making `SESSIONS_ROOT` reach into a named Docker volume. Requires the
  container's own compose config to bind-mount `.claude` to a host path;
  nothing on ResumerAgent's side can do this from outside the container.
- Any change to the `swiss-claude-cli` repo or its `docker-compose.yml`.
  That's a separate, shared team resource and a separate piece of work if
  ever undertaken.
- Any path style beyond `native` (no-op) and `wsl` (the standard
  Docker-Desktop-on-WSL2 conversion). Nobody has hit a need for anything
  else yet.

## Design

### 1. `CWD_STYLE` — path transform

New file `lib/cwdStyle.mjs`:

```js
export function transformCwd(winPath, style) {
  if (style !== 'wsl' || !winPath || winPath.length < 2) return winPath;
  const drive = winPath[0].toLowerCase();
  const rest = winPath.slice(2).replace(/\\/g, '/');
  return `/mnt/${drive}${rest}`;
}
```

`lib/config.mjs` reads `CWD_STYLE` (`'wsl'` or anything else falls back to
`'native'`, the current no-op behavior — an unrecognized value never throws,
consistent with every other config default in this file).

`lib/resumeCommand.mjs`'s `buildResumeCommand()` gains a `cwdStyle` param,
applies `transformCwd(session.cwd, cwdStyle)` before the existing
`{cwd}` substitution. `{sessionId}`/`{id}` are opaque identifiers, never
paths — they are never transformed.

`server.mjs`'s call site passes `cwdStyle: config.cwdStyle`.

This transform is deliberately scoped to *only* this one substitution point.
`discoverSessions.mjs`, `sessionRegistry.mjs`, and `purgeSession.mjs` all
read/write the *host* filesystem directly via `node:fs` — those paths are
always native Windows paths regardless of what `claude` itself runs inside,
and must never be transformed.

### 2. `LIVE_AGENTS_COMMAND` — configurable liveness check

`lib/config.mjs` reads `LIVE_AGENTS_COMMAND`, default `'claude agents --json
--all'` (byte-identical to today's hardcoded invocation).

`lib/liveAgents.mjs` changes from `execFile('claude', [argv...])` to
`exec(commandString)` — the same shell-string-execution model
`RESUME_COMMAND`/`ATTACH_COMMAND` already use. This is *not* a new trust
boundary: both are user-configured shell strings the user fully controls via
their own `.env`, executed the same way. The existing ENOENT-vs-other-error
diagnostic logging (added in the handover-audit fixes) is unaffected — both
`execFile` and `exec` produce error objects with the same `.code` field.

Contract: whatever `LIVE_AGENTS_COMMAND` runs must print to stdout the same
JSON array-of-session-objects shape `claude agents --json --all` produces
today. ResumerAgent validates only `Array.isArray(parsed)`, exactly as it
does now — no deeper shape validation is added or was ever present.

`server.mjs`'s call site passes `config.liveAgentsCommand` to
`readLiveAgents()`.

### 3. Documentation

- `README.md`'s "Running Claude Code through Docker?" section becomes a
  checklist: bind-mounted `.claude` (precondition this design doesn't
  solve), a resume/attach-capable command inside the container, and now
  liveness visibility — plus a concrete worked example wiring
  `SESSIONS_ROOT`, `RESUME_COMMAND`, `ATTACH_COMMAND`, `CWD_STYLE=wsl`, and
  `LIVE_AGENTS_COMMAND` together for a Docker-Desktop-on-WSL2 setup.
- `AGENT_SETUP.md` gets one new troubleshooting row: a docker-based session
  that's actually running but always shows as dead/resumable → check
  `LIVE_AGENTS_COMMAND` is actually reaching the container.
- `.env.example` documents both new vars with the same comment style as the
  existing four.

## Testing

- `lib/cwdStyle.test.mjs` (new, `node:test`, same pattern as
  `lib/mergeSessions.test.mjs`): native is a no-op, `wsl` converts a
  representative path correctly, an empty/degenerate string doesn't throw.
- Existing `node --test lib/*.test.mjs` run stays green.
- `node --check` on every edited file.
- No relaunch of the real ResumerAgent server during implementation or
  testing (standing rule, see `AGENT_SETUP.md`'s hard rules) — verify the
  pure functions directly; ask the user to reload/relaunch to see it live.

## Risks

- The regex-free `wsl` transform doesn't handle UNC paths (`\\server\share`)
  or relative paths. Not a regression — nothing handles those today either
  — and nobody has hit this case. If it comes up, extend `cwdStyle.mjs`
  then, not now.
- Switching `lib/liveAgents.mjs` from `execFile` to `exec` changes quoting
  semantics slightly (shell interpretation vs. argv-array), but the default
  command string (`claude agents --json --all`) has no shell metacharacters,
  so default behavior is unaffected.
