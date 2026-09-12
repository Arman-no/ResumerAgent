# Activity / Observability Panel — Design

Date: 2026-09-12
Status: implemented (2026-09-12), sourcing decision resolved as a hybrid —
both options from "What's already available" were built, not just one:

1. **Transcript-tail parsing is the primary/default source**, since it needs
   zero configuration and works for anyone running this tool.
   `lib/transcriptPreview.mjs` extends the same backward tail-scan that
   already found the preview/rename to also capture the last
   `{"type":"cost-state", totalCostUSD}` line Claude Code itself writes into
   the transcript (a real, native CLI feature, confirmed against the
   installed `claude.exe` binary — not a plugin artifact from this dev
   machine's own hook stack) and the last assistant turn's
   `message.usage` (approximates context-window usage as
   `(input + cache_creation + cache_read) / 200_000`; see the `ponytail:`
   comment on `CONTEXT_WINDOW_TOKENS` for that 200k assumption's ceiling —
   it undercounts a session actually running under the 1M-context beta).
   Finding this reliably required two real fixes over the naive version:
   the tail read had to grow from 200KB to 2MB (a `cost-state` line on a
   real long-running transcript sat 300-500KB from the end, not near it),
   and the scan's early-exit condition had to include "found a cost-state
   line", not just preview+customName — Claude Code's own periodic
   auto-retitling means a fresh `custom-title` line is almost always
   within the first few KB, which was silently short-circuiting the scan
   before it ever reached back far enough. Both fixes are in
   `lib/transcriptPreview.mjs` with comments explaining why.
   **This alone cannot recover rate-limit data at all** — confirmed while
   implementing, not just asserted: `rate_limits.*` has no transcript
   representation of any kind, only ever computed for the statusline JSON.
2. **The optional statusline-sidecar half of the hybrid was also built**,
   not left as a future option — the user wired up their own
   `~/.claude/statusline.ps1` to write one, tested it live, and handed
   this repo the verified JSON contract to read against
   (`lib/activitySidecar.mjs`, path `<sessionsRoot>/activity/<sessionId>.json`,
   matched by filename). Where both sources have a value (cost, context %),
   the sidecar's wins — it's Claude Code's own fresher, live-computed
   number, including for a live session that hasn't hit a transcript
   cost-state checkpoint yet, which transcript parsing structurally can't
   see. Rate limits (`rate_limits.five_hour`/`seven_day`) come from the
   sidecar exclusively, since there's no other source; absent for any
   session without one (the common case for anyone else running this
   tool), the panel just shows nothing for that piece rather than "n/a" on
   every row. One real gotcha found and fixed: the sidecar file is written
   with a UTF-8 BOM (PowerShell `Out-File`/`Set-Content`'s default), which
   `JSON.parse` rejects outright unless stripped first — see
   `lib/activitySidecar.mjs`.

The global "combined 5h usage rollup" (optional stretch, "What it could
look like") was **not** built — the per-session 5h/7d figures already show
up per row when a sidecar is present, and a separate rollup felt like
premature scope given the doc's own caution about the additive assumption
needing confirmation first.
Repo: `ResumerAgent`

## Where this came from

An Instagram reel (@chase.h.ai) describing a 3-step "agentic OS" pattern —
domains/skills/automations, an Obsidian-based memory layer (the same
Karpathy LLM-Wiki lineage `obsidian-second-brain` is already built on), and
an "observability" layer that turns what agents are doing into a dashboard
anyone can glance at, even non-CLI people. The first two pieces are already
covered by this user's existing setup; the third — a live activity view
across running agents — is the one gap, and ResumerAgent is the natural
place for it: it already lists every session, live and dead, in one
browser page.

## Problem

ResumerAgent today answers "which sessions exist and can I get back into
one" — a static/point-in-time view. It doesn't answer "what is happening
right now across my agents" — token usage, whether a session is near its
rate limit, how much a session has cost so far, or what it's actively
doing. For someone running several named sessions in parallel (this user's
actual pattern: Session A, Session B, Session C, Session D,
Trade), that's exactly the kind of at-a-glance status a second monitor tab
would be useful for.

## What's already available, and where

Claude Code's statusline JSON payload (see `code.claude.com/docs/en/statusline`)
carries, per live session, exactly the fields an observability panel would
need: `cost.total_cost_usd`, `cost.total_duration_ms`,
`context_window.used_percentage`, `rate_limits.five_hour.used_percentage` /
`resets_at`, `rate_limits.seven_day.*`, `session_name`, `model.display_name`.
That data is only piped to a statusline script while a session is actively
running, though — ResumerAgent's existing discovery mechanism
(`lib/discoverSessions.mjs`, `lib/liveAgents.mjs`) works from transcript
files and `claude agents --json --all`, neither of which currently surfaces
rate-limit/cost data.

Two realistic ways to get it into the dashboard, worth weighing rather than
picking blind:

1. **Have the user's own statusline script also write a small JSON
   sidecar file per session** (e.g. next to the transcript, or under a
   shared `~/.claude/activity/<session_id>.json`) every time it runs.
   ResumerAgent reads those sidecars alongside its existing transcript
   scan. Pro: reuses data Claude Code already computes, near-zero extra
   cost. Con: only as fresh as the last statusline refresh, and requires
   the user to have a statusline configured (this user now does, but it's
   not guaranteed for anyone else running this tool).
2. **Parse cost/context signals directly out of the transcript `.jsonl`**
   the way `transcriptPreview.mjs` already reads the tail for a message
   preview. Pro: works with zero extra configuration. Con: heavier
   per-request parsing, and rate-limit/reset data specifically is not
   part of the transcript format — only the statusline JSON gets it — so
   this route can't recover the rate-limit piece at all.

A hybrid (sidecar for rate-limits/cost when present, transcript-tail
fallback for everything else) is probably the real answer, but that's a
scoping decision for whoever picks this up, not something to lock in here.

## What it could look like

Not a new page — a collapsible panel or extra column on the existing
session list, since the point is "glance at what's already open," not a
second thing to navigate to:

- A small usage bar per session (context %, matching the color thresholds
  already established in this user's own Claude Code statusline: green
  <70%, yellow 70–89%, red ≥90%) — reuses the design language they already
  chose.
- Session cost so far, if the sidecar/parsing route surfaces it.
- Last-active timestamp (already have this — `updatedAt`) shown as
  "active 2m ago" instead of a raw date.
- Optional: a global "combined 5h usage" rollup if `rate_limits.five_hour`
  data is present for more than one session (they should all report the
  same account-wide percentage, since rate limits are per-account, not
  per-session — worth confirming that assumption before displaying it as
  if it were additive).

## Non-goals

- Not a replacement for the statusline itself — this is a glance-at-many
  view, the statusline is the glance-at-one-you're-in view.
- Not real-time push/websocket for v1 — a page refresh or the existing
  polling model is enough; don't add infrastructure this doesn't need yet.
- Doesn't try to control or steer a running session — read-only, same as
  the rest of ResumerAgent's current scope (resume/attach/purge are the
  only actions it takes, and those are already scoped to dead/known-safe
  sessions).

## Where to start

- `lib/discoverSessions.mjs` / `lib/liveAgents.mjs` — where per-session
  data already gets assembled; this is where a sidecar-read or
  transcript-tail-parse would plug in.
- The statusline script this user already has at `~/.claude/statusline.ps1`
  — if the sidecar-write approach is chosen, that's the natural place to
  add "also write this JSON out," since it already receives the full
  payload every refresh.
- Frontend session-row rendering (same spot the expiry-warning design doc
  from earlier this week points at) — the usage bar would live here too.
