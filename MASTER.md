# Design System Master File

> **LOGIC:** This is the single source of truth for ResumerAgent's visual
> and interaction design. There are no per-page overrides in this project
> (it's a one-page dashboard) — every rule below applies everywhere.
> Generated via the `ui-ux-pro-max` design-system format, hand-populated
> with the tokens validated in the `genjutsu:paint` Phase 1 (brainstorm) /
> Phase 2 (thesis) live-preview approval — not re-derived, not re-run
> through the generic recommendation engine.

---

**Project:** ResumerAgent
**Category:** Local dashboard / dev tool (dark command-center)
**Generated:** 2026-09-12

---

## Visual Thesis (validated)

> A dark command-center dashboard — near-black slate ground, a single cool
> teal accent reserved for chrome and focus, monospace numerals doing the
> talking on a few oversized glanceable stats, dense quiet cards for the
> long session list underneath.

## Interaction Thesis (validated)

> Fast and quiet (150–200ms). Hover raises a border to the accent color,
> nothing scales or bounces. No scroll-triggered reveals — a dashboard
> shows everything at rest.

**Forbidden:** spring/elastic easing, decorative motion, anything that
delays reading real data.

---

## Global Rules

### Color Palette

Two themes, explicit toggle (see Theming below) — dark is the default.

| Role | Dark | Light | CSS Variable |
|------|------|-------|--------------|
| Background | `#0E1013` | `#EDF1F3` | `--bg` |
| Surface (cards, controls) | `#16191D` | `#FFFFFF` | `--surface` |
| Surface, one step up (nested panels) | `#1E2227` | `#F5F7F8` | `--surface-2` |
| Border | `#292E34` | `#DDE3E7` | `--border` |
| Text | `#E7E9EC` | `#171B1F` | `--text` |
| Text, muted | `#868C95` | `#5B6570` | `--text-muted` |
| Accent (chrome only — see below) | `#45B8CC` | `#1C8DA3` | `--accent` |
| Accent, soft fill (sparkline area, hover tints) | `#173238` | `#DCF0F3` | `--accent-soft` |
| Accent, as plain text (links, `.btn-attach` label) | `#45B8CC` | `#17727F` | `--accent-text` |
| Success | `#5FBF8A` | `#2F9E68` | `--success` |
| Warning | `#E0B04A` | `#B8860F` | `--warning` |
| Critical | `#E0685A` | `#C23B2E` | `--critical` |

**Alpha-blended tints** (pill/badge backgrounds, danger-button borders) use
an `--{role}-rgb` companion variable (e.g. `--success-rgb: 95, 191, 138`)
so `rgba(var(--success-rgb), 0.12)` stays sourced from this file instead of
a hand-picked literal drifting out of sync with the hex token. Defined for
`accent`, `success`, `warning`, `critical`, `text-muted`.

**Color usage rule — the load-bearing one:** accent is spent *only* on
chrome — theme toggle, focus rings, links, active nav/filter state, the
sparkline line color, primary action buttons. It is **never** used for
status. Status (live/idle/busy, context-window %, rate-limit bands) uses
success/warning/critical *exclusively*, matching the thresholds already
established in this codebase's statusline convention:

| Band | Threshold | Color |
|------|-----------|-------|
| Healthy | < 70% | `--success` |
| Approaching limit | 70–89% | `--warning` |
| At/near limit | ≥ 90% | `--critical` |

Session activity states map onto the same three-color budget rather than
inventing a fourth hue: `idle`/`busy` (both "live and working normally") →
success; `waiting`/`running elsewhere unconfirmed` (both "worth a glance")
→ warning; `resumable`/`superseded`/`status unknown` (inactive, not
unhealthy) → neutral `--text-muted`, no status color at all.

**`--accent` vs `--accent-text`:** `--accent` is the validated hex, used for
borders, focus rings, fills, and the sparkline line — contexts WCAG doesn't
hold to the 4.5:1 text-contrast bar. `--accent-text` exists only because
light mode's `--accent` (#1C8DA3) measures 3.43–3.90:1 as plain text —
short of that bar. It's the same hex as `--accent` in dark mode (already
passes) and a darkened #17727F in light mode, applied only where accent is
literal text color (`.link-btn`, `.btn-attach`'s label).

### Typography

- **Data font (numbers, IDs, paths):** IBM Plex Mono
- **Label/body font:** IBM Plex Sans
- **Google Fonts:** `@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');`
- **Big stat numbers:** 22px, IBM Plex Mono, weight 600 — the one place
  this app goes oversized relative to its 13px body text, sized down from
  an initial 34px (2026-09-12 pass: the 4 stat cards read as oversized at
  that size) while staying clearly bigger than every other number on the
  page. Applied via `--font-mono` on `.stat-value`, `.row-cwd`, `.row-id`.
- Everything else (row names, filter labels, buttons, badges) is
  IBM Plex Sans via `body`'s default `--font-sans`.

### Spacing Scale

| Token | Value |
|-------|-------|
| `--space-4` | 4px |
| `--space-8` | 8px |
| `--space-12` | 12px |
| `--space-16` | 16px |
| `--space-24` | 24px |
| `--space-32` | 32px |
| `--space-48` | 48px |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-lg` | 16px | The 4 feature stat cards — elevated, the one bold shape in the UI |
| `--radius-md` | 10px | Reserved for a future mid-weight surface (not currently used — no element sits between the stat cards and the flat controls today) |
| `--radius-sm` | 8px | Everything else: session rows, buttons, inputs, badges, activity strip |

Boldness spent once, on the 4 stat cards, not on every repeated row —
session cards are flat (`--radius-sm`, no shadow, tight spacing).

### Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.3)` (dark) / `rgba(20,30,35,.06)` (light) | Reserved, not currently applied to any element |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,.45)` (dark) / `rgba(20,30,35,.10)` (light) | Stat cards, toast |

Session rows are explicitly shadow-free — flat is the point.

---

## Theming

Explicit dark/light toggle in the header (`#theme-toggle-btn`), not
OS-preference-driven — this is a single-user local tool, and the validated
thesis calls for a hard default to dark regardless of system setting. State
lives in `localStorage` (`resumeragent-theme`), applied as
`document.documentElement.dataset.theme` before first paint (inline script
in `<head>`, avoiding a flash of the wrong theme):

```js
document.documentElement.dataset.theme = localStorage.getItem('resumeragent-theme') || 'dark';
```

`:root` carries the dark values as the unconditional default;
`[data-theme="light"]` overrides only the color tokens. Spacing/radius/font
tokens aren't theme-dependent, so they're defined once in `:root` and
inherited either way.

---

## Component Specs

### Stat cards (new)

```css
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-16);
  transition: border-color 180ms ease-out;
}
.stat-card:hover { border-color: var(--accent); }
.stat-value { font-family: var(--font-mono); font-size: 22px; font-weight: 600; }
```

Each card: a label, an oversized mono number, and an inline SVG sparkline
(accent line + accent-soft area fill). See "Sparkline honesty" below for
what each of the 4 sparklines actually plots.

### Session row (restyled)

```css
.session-row {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-12);
  transition: border-color 150ms ease-out, opacity 150ms ease-out;
}
.session-row:hover { border-color: var(--accent); }
```

No background tint, no translate, no scale on hover — border-to-accent
only, per the validated interaction thesis. All existing functionality
(expiry badge, activity strip, empty-states, superseded dimming) is
preserved as-is; only the tokens and the hover mechanic changed.

### Buttons

- `.btn-primary` — solid `--accent` fill, white text (Resume).
- `.btn-attach` — outlined `--accent`, transparent fill (Attach — joining,
  not launching, deliberately not styled as an equally-weighted CTA).
- `.btn-secondary` — neutral `--border` fill (disabled/inert states).
- `.icon-btn-danger` — `--critical`, filled on `.armed` (Purge).
- `.icon-btn-pause` — `--warning` at rest and `.armed` (Pause, a live
  background job — fully resumable via `claude stop`, but still a
  process-stopping action, so it doesn't borrow Purge's critical red).
- `.icon-btn-close` — `--accent` at rest (Close, a live interactive
  session), `--warning` on hover and `.armed`. The only button whose rest
  and interactive colors differ — deliberately: at rest it reads as a
  normal control matching Attach's language, and only shifts to warning
  the moment you're actually about to act on it. Chosen 2026-09-13 from a
  3-option preview after the reused `.icon-btn-danger` (red ✕) read as
  "delete" for an action that's fully resumable.
- Focus: `outline: 2px solid var(--accent); outline-offset: 2px;` on every
  interactive element via `:focus-visible`.

### Pills / badges

Status pills use `currentColor` for a small leading dot plus a
`rgba(var(--{role}-rgb), 0.12–0.15)` tinted background — see the Color
Palette section above for the exact idle/busy/waiting/external mapping.

---

## Sparkline Honesty

This app has never persisted a time-series of its own aggregate stats —
only per-session snapshots. Rather than fabricate trend history that
doesn't exist:

- **Sessions tracked** — real trend. Every session's `createdAt` is a
  genuine distinct timestamp, so `lib/statsSummary.mjs` buckets real
  session-creation counts into a 14-day daily series.
- **Live now**, **Total cost**, **Avg context used** — no historical
  series exists (these are point-in-time aggregates recomputed fresh on
  every poll). Their sparklines are honestly flat: a single current-value
  point, rendered as a flat line rather than a fabricated curve or a
  meaningless dot.

---

## Anti-Patterns (Do NOT Use)

- ❌ Accent color used for a status/health signal (context %, rate limit,
  live/idle/busy) — status is success/warning/critical, exclusively.
- ❌ A new hex/rgb literal introduced outside this file's token
  definitions — including inside an `rgba()` tint; use the `--{role}-rgb`
  companion variable instead.
- ❌ Spring/elastic/bounce easing or scale-on-hover — hover is
  border-color-to-accent only.
- ❌ Scroll-triggered reveals — this is a dashboard, everything shows at
  rest.
- ❌ Emojis as icons — hand-drawn monochrome stroke SVGs (`currentColor`)
  only, matching the icons already in `public/index.html`.
- ❌ `outline: none` without a `:focus-visible` replacement.
- ❌ A fabricated sparkline trend for a stat with no real history — flat is
  the honest default.

---

## Pre-Delivery Checklist

- [ ] No emojis used as icons
- [ ] `cursor: pointer` on all clickable elements
- [ ] Hover states are fast (150–200ms) and don't scale/bounce
- [x] Light mode: text contrast ≥ 4.5:1 (verified against the exact tokens
      above — see `--accent-text` for the one token that needed to differ
      from its non-text counterpart to clear this)
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected (status pulses, row enter/leave,
      spinners, shake, count-pop all disabled)
- [ ] No hex/rgb color value outside this file's token definitions
- [ ] Sparklines render as static SVG — no per-frame JS, nothing to jank at
      60fps
