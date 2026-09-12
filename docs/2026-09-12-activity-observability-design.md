# Activity / Observability Panel — Design

Date: 2026-09-12
Status: idea, not yet scoped into a plan — pointer doc for whoever picks this up
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
