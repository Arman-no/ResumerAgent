# Backlog

Requested features not yet designed or built. Newest first.

## Rate-limit line: statusline-style bars (requested 2026-09-16)

**Problem.** The per-row rate-limit line is confusing and hard to read at a glance:

```
Rate limit — 5h: 17% · 7d: 52% (as of 13m ago)
```

**Wanted.** Match the Claude Code statusline footer format exactly:

```
Usage #--------- 19% (resets in 3h 36m) | Week #####----- 52% (resets in 2h 26m)
```

- A 10-cell text bar per window (`#` used, `-` remaining), then the percentage, then time until reset.
- Labels: `Usage` for the 5-hour window, `Week` for the 7-day window, separated by ` | `.

**Notes for whoever builds it.**
- Current rendering: `rateLimitLineHtml()` in `public/app.js`.
- The data already has what's needed: the sidecar carries `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at` (`lib/activitySidecar.mjs`).
- Decide what happens to the "as of" freshness note. The sidecar can be stale, so "resets in" should be computed from `resets_at` against the current time, not the time of the sidecar's last write.
- Keep the existing <70 / 70–89 / ≥90 color bands.
- Follow `MASTER.md` for type and color tokens.
