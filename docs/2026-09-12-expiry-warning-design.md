# Session Expiry Warning — Design

Date: 2026-09-12
Status: implemented (2026-09-12) — built as designed, no deviations.
`lib/config.mjs` reads `cleanupPeriodDays` from `<sessionsRoot>/settings.json`;
`lib/expiry.mjs` has the pure day-count math (tested in `lib/expiry.test.mjs`);
`server.mjs` threads `daysUntilExpiry` onto each session in `getSessionsPayload()`
and reconciles `DISCOVERY_WINDOW_MS` against `cleanupPeriodDays` per point 3
below; `public/app.js`/`styles.css` add the `⚠ expires in Nd` badge, shown only
at <=5 days (no badge otherwise — "no visual noise" taken literally). The
optional "touch" action (point 4) was not built — left as a real stretch goal,
not silently dropped.
Repo: `ResumerAgent`

## Problem

Claude Code auto-deletes a session's transcript when it goes stale: on every
`claude` startup, it computes a cutoff (`now - cleanupPeriodDays` days, from
`~/.claude/settings.json`'s `cleanupPeriodDays`, default 30) and deletes any
`.jsonl` under `<SESSIONS_ROOT>/projects/**` whose **last-modified time** is
older than that cutoff. This is silent — no warning, no trash/soft-delete, no
recovery path (confirmed against multiple upstream reports: anthropics/
claude-code issues #62959, #59248, #62476, #64999).

A session that's touched regularly never hits this (every new message
refreshes its mtime). The risk is a session you park for a few weeks and
come back to later — it can be gone with zero notice.

ResumerAgent already surfaces every session with its `updatedAt` (mtime) —
see `lib/discoverSessions.mjs` — so it already has everything needed to warn
about this before it happens.

## Goal

Show, per session row in the dashboard, how many days remain before Claude
Code's own cleanup would delete it — and flag anything getting close.

## Proposed behavior

1. **Read the real threshold.** Load `cleanupPeriodDays` from
   `<SESSIONS_ROOT>/settings.json` (fall back to Claude Code's own default of
   30 if the key is absent; treat `0` as "cleanup disabled — never expires").
   `SESSIONS_ROOT` is already resolved in `lib/config.mjs`.
2. **Compute per-session expiry.** For each session already returned by
   `discoverSessions()`, `daysUntilExpiry = cleanupPeriodDays - (now -
   updatedAt) / 86_400_000`. No new file reads needed — `updatedAt` is
   already on the session object.
3. **Surface it in the UI:**
   - Normal (e.g. > 5 days left): no visual noise, maybe a subtle muted label.
   - Warning (e.g. ≤ 5 days left): a visible badge, e.g. `⚠ expires in 3 days`.
   - Already stale from ResumerAgent's own POV (older than the discovery
     window `DISCOVERY_WINDOW_MS` in `server.mjs`) won't even show up — that
     ceiling should be reconciled with `cleanupPeriodDays` so a session
     doesn't silently drop out of the dashboard *before* its own warning
     would have fired.
4. **Optional stretch:** a "touch" action per session — resume-and-
   immediately-exit, or just update the file's mtime directly — to reset
   the clock on something you want to keep without actually resuming work
   on it right now. Needs a decision on whether silently bumping mtime
   without user awareness of the underlying mechanism is acceptable, or
   whether it should always go through an actual `claude --resume`.

## Non-goals

- Don't try to prevent or intercept Claude Code's own deletion — it runs
  independently at Claude Code startup, outside this tool's process. This
  is a warning system, not a guard.
- Don't change `cleanupPeriodDays` from here — that's the user's own
  settings.json, edited directly or via Claude Code's `/config`/update-config
  flow, not something this dashboard should write to.

## Where to start

- `lib/discoverSessions.mjs` — session objects already have `updatedAt`.
- `lib/config.mjs` — extend to also read `cleanupPeriodDays` from
  `<SESSIONS_ROOT>/settings.json` (new read, small JSON file, same directory
  already resolved for `SESSIONS_ROOT`).
- `server.mjs` — thread the resolved `cleanupPeriodDays` through to
  whatever assembles the JSON payload the frontend renders.
- Frontend session-row rendering (wherever that currently lives) — add the
  badge described above.
