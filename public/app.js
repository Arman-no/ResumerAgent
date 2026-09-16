const POLL_INTERVAL_MS = 5 * 60 * 1000;

const statCardsEl = document.getElementById('stat-cards');
const sessionListEl = document.getElementById('session-list');
const emptyEl = document.getElementById('empty');
const noMatchesEl = document.getElementById('no-matches');
const errorEl = document.getElementById('error');
const lastRefreshedEl = document.getElementById('last-refreshed');
const toastEl = document.getElementById('toast');
const resultCountEl = document.getElementById('result-count');
const filterSearchEl = document.getElementById('filter-search');
const filterWhenEl = document.getElementById('filter-when');
const sortSelectEl = document.getElementById('sort-select');
const statusCheckboxes = document.querySelectorAll('#filters input[data-status]');
const statusAllEl = document.getElementById('status-all');
const heartbeatEl = document.getElementById('heartbeat');
const refreshIconEl = document.querySelector('#refresh-btn .refresh-icon');

function pulseHeartbeat() {
  heartbeatEl.classList.remove('ping');
  void heartbeatEl.offsetWidth; // restart the CSS animation on repeat pings
  heartbeatEl.classList.add('ping');
}

const TRASH_ICON = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 7h16" />
    <path d="M10 11v6M14 11v6" />
    <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
  </svg>
`;
const PAUSE_ICON = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
`;
// Power icon, not an X — user feedback 2026-09-13: the X (reused from
// Purge/Delete's own icon) read as "delete", which Close never does.
// Chosen from a 3-option artifact preview; see docs/2026-09-13-pause-session-design.md.
const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3v8" />
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
  </svg>
`;
const SPINNER_ICON = `<span class="btn-icon-spinner"></span>`;
// Copy is the universal fallback for the terminal-spawn path, which can't
// be made to work on every OS/terminal emulator — so unlike Pause/Close/
// Purge above, this icon has no color modifier and no disabled state: it
// must render on every row, including ones where Resume/Attach itself is
// disabled (live, superseded, status-unknown).
const COPY_ICON = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="8" y="8" width="12" height="12" rx="1.5" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </svg>
`;

const DELETE_LABEL = 'Delete session';
const PAUSE_LABEL = 'Pause session';
const CLOSE_LABEL = 'Close session';
const COPY_LABEL = 'Copy resume command';
const CONFIRM_LABEL = 'Click again to confirm';

// Sessions as last returned by the server — filters below never re-fetch,
// they narrow this in place, so toggling a filter feels instant instead of
// waiting on a network round trip.
let rawSessions = null;

const STATUS_KEYS = ['live', 'resumable', 'unknown', 'superseded'];

const filterState = {
  search: '',
  when: 'all',
  statuses: new Set(STATUS_KEYS),
  sortBy: 'createdAt-desc',
};

const rowsByKey = new Map();
// sessionId -> a signature of the session data the row currently reflects.
// Every 5s poll called renderRow() (full innerHTML rebuild) for every row
// unconditionally, even when nothing about the session had actually
// changed — visible as the whole list flashing on every poll. Skipping the
// rebuild when the signature matches fixes that without losing real
// updates (status changes, a new preview line, etc. always change the
// signature and still rebuild).
const rowSignatures = new Map();
let firstLoad = true;
let lastRefreshedAt = null;
// Set from the first successful poll's startedAt; compared against every
// later poll so a code change on the server is noticed even though this
// tab's own app.js has no way to reload itself.
let knownServerStartedAt = null;

// sessionId -> pending confirm-window timeout, for the two-click purge and
// pause confirmations below — one Map per action, since a session could in
// principle have both a live-session pause and (after it drops out of
// live) a purge armed across separate polls, and they must not clear each
// other.
const purgeConfirmTimers = new Map();
const pauseConfirmTimers = new Map();
const closeConfirmTimers = new Map();

function clearConfirmTimer(timers, sessionId) {
  const timerId = timers.get(sessionId);
  if (timerId) {
    clearTimeout(timerId);
    timers.delete(sessionId);
  }
}

function clearPurgeConfirm(sessionId) {
  clearConfirmTimer(purgeConfirmTimers, sessionId);
}

function clearPauseConfirm(sessionId) {
  clearConfirmTimer(pauseConfirmTimers, sessionId);
}

function clearCloseConfirm(sessionId) {
  clearConfirmTimer(closeConfirmTimers, sessionId);
}

function sessionKey(s) {
  return s.sessionId;
}

// Deliberately excludes nothing — every field here is something a real
// rebuild should react to. relativeTime() is handled separately (see
// renderSessions) precisely so it can keep advancing every poll without
// needing a signature change, rather than being baked in here and forcing
// a full rebuild every 5 seconds purely because time passed.
//
// A parent's rendered row includes a summary of its child's own status
// (see childLinkHtml) — folding the child's signature in too means the
// parent's row correctly rebuilds when only the child changed, which its
// own fields alone would never reveal.
function sessionSignature(session, sessionsById) {
  const child = session.childSessionId ? sessionsById?.get(session.childSessionId) : null;
  return child ? JSON.stringify([session, child]) : JSON.stringify(session);
}

// A parent's own liveness is exactly the gap that produces "running
// elsewhere" (claude agents doesn't report an interactive session once it
// parks a background job under it) — but the child IS independently
// confirmed, so once we have it, its status is strictly more informative
// than the parent's own hedge. Shared by statusKey/statusLabel/statusClass
// below rather than duplicated in each.
function childStatusOverride(session, sessionsById) {
  if (!session.childSessionId || !sessionsById) return null;
  const child = sessionsById.get(session.childSessionId);
  return child && !child.liveUnknown ? child : null;
}

// The four states filterable in the sidebar — distinct from statusLabel
// below, which additionally shows *what* a live session is doing
// (idle/busy/waiting). Filtering only needs the coarser live/resumable/
// unknown/superseded split. superseded is checked first: it's a subset of
// what would otherwise read as "resumable" (not live, liveness confirmed),
// but nothing useful can be done with it besides purge, so it gets its own
// filter instead of being silently lumped in with genuinely-resumable ones.
function statusKey(session, sessionsById) {
  if (session.superseded) return 'superseded';
  const child = childStatusOverride(session, sessionsById);
  if (child) return statusKey(child, sessionsById);
  if (session.liveUnknown) return 'unknown';
  return session.live ? 'live' : 'resumable';
}

function statusLabel(session, sessionsById) {
  if (session.superseded) return 'retired';
  const child = childStatusOverride(session, sessionsById);
  if (child) return statusLabel(child, sessionsById);
  if (session.liveUnknown) {
    if (!session.pidConfirmedAlive) return 'status unknown';
    // The registry keeps a real status (idle/busy) updating even for a
    // session `claude agents` itself never reports at all — confirmed
    // 2026-09-14: an interactive session that parks a background job
    // under it (registry's own parkedJobId) drops out of `claude agents`
    // entirely while the process stays fully alive. A bare "running
    // elsewhere" with no status made a perfectly idle session read as
    // something to worry about, when the real status was known all along.
    return session.status && session.status !== 'unknown'
      ? `running elsewhere · ${session.status}`
      : 'running elsewhere';
  }
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session, sessionsById) {
  if (session.superseded) return 'status-superseded';
  const child = childStatusOverride(session, sessionsById);
  if (child) return statusClass(child, sessionsById);
  if (session.liveUnknown) return session.pidConfirmedAlive ? 'status-external' : 'status-resumable';
  return session.live ? `status-${session.status}` : 'status-resumable';
}

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

function formatSize(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Same green/yellow/red bands this user's own statusline already uses
// (docs/2026-09-12-activity-observability-design.md) — reusing the
// convention they already read at a glance rather than inventing another.
// Returns the bare tier so both the context bar (background-colored) and
// the rate-limit numbers (text-colored) can build their own class name
// from it, instead of duplicating the 70/90 thresholds in two places —
// design-review finding: rate-limit % previously carried no color coding
// at all despite representing the exact same "how close to a ceiling"
// concept this whole panel exists to surface (see the design doc's
// Problem section: "whether a session is near its rate limit").
function usageBand(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

// Only fires inside the design doc's warning window (<=5 days) — a normal
// session shows nothing here at all, deliberately: the point is "no visual
// noise" until it's actually worth interrupting on.
function expiryBadgeHtml(session) {
  const days = session.daysUntilExpiry;
  if (days == null || days > 5) return '';
  const urgent = days <= 1;
  const label = days <= 0 ? 'expires imminently' : `expires in ${Math.max(1, Math.floor(days))}d`;
  return `<span class="expiry-badge ${urgent ? 'expiry-urgent' : ''}" title="Claude Code's own cleanup (cleanupPeriodDays) will delete this transcript soon unless it's touched again">⚠ ${escapeHtml(label)}</span>`;
}

// Cost + context share a line. No leading icon glyph — checked against
// this app's own established convention for a line of small inline stats
// (.row-sub: badge/branch/size, separated by "·", no icons) rather than
// its separate convention for standalone action buttons (theme toggle,
// refresh, purge — those *are* icon-only, but they're controls, not a
// stats readout). The design-review pass flagged the previous 💰/📊
// emoji as the one part of this strip that didn't fit either convention:
// full-color OS glyphs in an app where every other icon is a hand-drawn
// monochrome stroke SVG using currentColor, un-themeable and read aloud
// by name ("money bag") ahead of the actual text by a screen reader.
// Dropping them outright — not swapping in two new SVGs — is the smaller,
// more consistent fix: it makes this line match row-sub's own plain-text
// pattern exactly, rather than inventing a third icon convention.
// Returns '' when neither is available, so the caller can fall back to a
// placeholder instead of rendering an empty line.
function costContextLineHtml(session) {
  const items = [];
  if (typeof session.costUsd === 'number') {
    items.push(`<span class="activity-item" title="Total cost so far this session">$${session.costUsd.toFixed(2)}</span>`);
  }
  if (typeof session.contextUsedPercent === 'number') {
    const pct = Math.round(session.contextUsedPercent);
    // "/200k" dropped from the tooltip — no longer true for every session
    // since lib/transcriptPreview.mjs now sizes the window per the
    // session's own model (1M for current-gen models, 200k otherwise).
    // The auto-compaction note answers the confusion a 100% reading
    // actually caused in real use (captured verbatim in a real session's
    // own preview text during this design pass: "why for some agents...
    // is it shoing 100% ctx? it's unclear... better to have more
    // clarity") — the number was in that case correct, just unexplained.
    items.push(`
      <span class="activity-item context-item" title="Approx. context window used, sized to this session's own model — Claude Code compacts automatically as this nears 100%">
        <span class="context-bar-track"><span class="context-bar-fill context-${usageBand(session.contextUsedPercent)}" style="width:${Math.min(100, session.contextUsedPercent)}%"></span></span>
        ${pct}% ctx
      </span>
    `);
  }
  if (items.length === 0) return '';
  return `<div class="activity-line">${items.join('')}</div>`;
}

// Mirrors this user's own statusline footer exactly (~/.claude/statusline.ps1
// Bar + RateLimitSegment): "Usage #--------- 19% (resets in 3h 36m) | Week
// #####----- 52% (resets in 2d 4h)". The earlier "Rate limit — 5h: 17% · 7d:
// 52% (as of 13m ago)" line read as confusing next to the footer the user
// actually watches. "resets in" counts down from resets_at against now, not
// the sidecar's write time, so a stale sidecar still shows the right reset.
function textBar(pct, width = 10) {
  const p = Math.max(0, Math.min(100, Math.trunc(pct)));
  const filled = Math.floor((p * width) / 100);
  return '#'.repeat(filled) + '-'.repeat(width - filled);
}

function resetsIn(resetsAtSec) {
  const secsLeft = Math.max(0, resetsAtSec - Math.floor(Date.now() / 1000));
  const totalHours = Math.floor(secsLeft / 3600);
  if (totalHours >= 24) return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
  return `${totalHours}h ${Math.floor((secsLeft % 3600) / 60)}m`;
}

function rateLimitSegmentHtml(label, win, sep = '') {
  if (typeof win?.used_percentage !== 'number') return '';
  const pct = Math.round(win.used_percentage);
  // A window whose reset time has already passed carries a pre-reset
  // percentage; say so instead of showing "resets in 0h 0m" beside a stale number.
  const reset = typeof win.resets_at !== 'number'
    ? ''
    : win.resets_at * 1000 <= Date.now()
      ? ' <span class="activity-freshness">(reset since last update)</span>'
      : ` <span class="activity-freshness">(resets in ${resetsIn(win.resets_at)})</span>`;
  return `<span class="rate-seg">${sep}<span class="rate-value rate-${usageBand(pct)}">${label} <span class="rate-bar">${textBar(pct)}</span> ${pct}%</span>${reset}</span>`;
}

function rateLimitLineHtml(session) {
  const rl = session.rateLimits;
  const items = [
    rateLimitSegmentHtml('Usage', rl?.five_hour),
    // The "|" leads the Week segment rather than trailing Usage, so a narrow
    // card that wraps them onto two lines never leaves a dangling separator.
    rateLimitSegmentHtml('Week', rl?.seven_day, typeof rl?.five_hour?.used_percentage === 'number' ? '<span class="rate-sep">|</span>' : ''),
  ].filter(Boolean);
  if (items.length === 0) return '';
  return `<div class="activity-line"><span class="activity-item rate-line" title="Your Claude plan's rate-limit usage (account-wide, from the statusline sidecar): Usage is the 5-hour window, Week the 7-day window">${items.join('')}</span></div>`;
}

// Groups cost/context/rate-limits into one small labeled, visually boxed
// strip (border + background, set apart from the row-sub file-metadata
// line above it) instead of scattering bare numbers next to git
// branch/file size. Every card gets this same box regardless of whether
// the data exists yet — a session with no statusline sidecar (most of
// them, right now: sidecars only exist for sessions active since this
// user wired up their statusline) still renders the same two-line shape,
// just with a dimmed placeholder line in place of what's missing, so
// card heights stay consistent across the whole list rather than jagged
// depending on which sessions happen to have data.
function activityStripHtml(session) {
  const costContextLine = costContextLineHtml(session);
  const rateLine = rateLimitLineHtml(session);
  if (!costContextLine && !rateLine) {
    return `<div class="activity-strip is-empty muted" title="No cost/context/rate-limit data yet — appears once this session has run with the statusline sidecar or a cost checkpoint in its transcript">no recent activity data</div>`;
  }
  const costContextPlaceholder = `<div class="activity-line muted">no cost/context data yet</div>`;
  const ratePlaceholder = `<div class="activity-line muted" title="Rate limits come from this user's own statusline sidecar — none written for this session yet">no rate-limit data yet</div>`;
  return `<div class="activity-strip">${costContextLine || costContextPlaceholder}${rateLine || ratePlaceholder}</div>`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Inline SVG sparkline: an accent-colored line plus a faint accent-soft
// area fill (validated visual thesis — accent is spent on chrome including
// "sparkline line color", never on status). A single-value series (the
// honest case for a stat this app has no real history for — see
// lib/statsSummary.mjs) draws as a flat horizontal line rather than a
// single dot, so "no trend data yet" still reads as a sparkline shape,
// not a rendering glitch.
function sparklineSvg(values) {
  const width = 72;
  const height = 24;
  const pad = 2;
  const series = values && values.length ? values : [0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const points = series.length > 1
    ? series.map((v, i) => [
        pad + (i * (width - pad * 2)) / (series.length - 1),
        height - pad - ((v - min) / range) * (height - pad * 2),
      ])
    : [[pad, height / 2], [width - pad, height / 2]];
  const lineStr = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaStr = `${pad},${height - pad} ${lineStr} ${width - pad},${height - pad}`;
  return `
    <svg class="stat-sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false">
      <polyline class="sparkline-area" points="${areaStr}"></polyline>
      <polyline class="sparkline-line" points="${lineStr}"></polyline>
    </svg>
  `;
}

function statCardHtml({ label, value, sparkline, title }) {
  return `
    <div class="stat-card" title="${escapeHtml(title)}">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value">${escapeHtml(value)}</span>
      ${sparkline}
    </div>
  `;
}

// Sessions tracked / live now are exact counts straight off the sessions
// array the server just returned. Total cost / avg context are only ever
// "—" when not a single session has that data yet (no sidecar, no
// cost-state line seen) — same "no data yet" convention the activity strip
// already uses per-row, rather than rendering a misleading $0.00.
function renderStats(stats) {
  if (!stats) return;
  const costLabel = stats.totalCostUsd == null ? '—' : `$${stats.totalCostUsd.toFixed(2)}`;
  const contextLabel = stats.avgContextUsedPercent == null ? '—' : `${Math.round(stats.avgContextUsedPercent)}%`;
  statCardsEl.innerHTML = [
    statCardHtml({
      label: 'Sessions tracked',
      value: String(stats.sessionsTracked),
      sparkline: sparklineSvg(stats.sparklines.sessionsTracked),
      title: 'Every session this dashboard currently sees, live or dead — daily new-session count, last 14 days',
    }),
    statCardHtml({
      label: 'Live now',
      value: String(stats.liveNow),
      sparkline: sparklineSvg(stats.sparklines.liveNow),
      title: 'Currently live sessions (claude agents-confirmed)',
    }),
    statCardHtml({
      label: 'Total cost',
      value: costLabel,
      sparkline: sparklineSvg(stats.sparklines.totalCostUsd),
      title: 'Sum of cost across every session with cost data',
    }),
    statCardHtml({
      label: 'Avg context used',
      value: contextLabel,
      sparkline: sparklineSvg(stats.sparklines.avgContextUsedPercent),
      title: 'Average context-window usage across sessions with context data',
    }),
  ].join('');
}

function matchesWhen(session, when) {
  if (when === 'all') return true;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const age = Date.now() - session.updatedAt;
  if (when === 'today') return age <= DAY_MS;
  if (when === 'week') return age <= 7 * DAY_MS;
  return true;
}

function matchesSearch(session, query) {
  if (!query) return true;
  return `${session.name}\n${session.cwd}`.toLowerCase().includes(query);
}

function compareSessions(a, b, sortBy) {
  switch (sortBy) {
    case 'createdAt-asc': return a.createdAt - b.createdAt;
    case 'updatedAt-desc': return b.updatedAt - a.updatedAt;
    case 'name-asc': return a.name.localeCompare(b.name);
    case 'createdAt-desc':
    default: return b.createdAt - a.createdAt;
  }
}

function applyFilters(sessions, sessionsById) {
  return sessions
    .filter((s) =>
      filterState.statuses.has(statusKey(s, sessionsById)) &&
      matchesWhen(s, filterState.when) &&
      matchesSearch(s, filterState.search)
    )
    .sort((a, b) => compareSessions(a, b, filterState.sortBy));
}

function updateResultCount(shown, total) {
  const next = total === 0
    ? ''
    : shown === total
    ? `${total} session${total === 1 ? '' : 's'}`
    : `${shown} of ${total} session${total === 1 ? '' : 's'}`;
  if (next === resultCountEl.textContent) return;
  resultCountEl.textContent = next;
  // Only pop when the text actually changed — the early return above is
  // what keeps this from replaying every single poll the way the row
  // list itself used to (same root class of bug, guarded the same way).
  resultCountEl.classList.remove('pop');
  // Forces a reflow so re-adding the class actually restarts the
  // animation instead of being a no-op (the class was never really
  // removed from the DOM's perspective otherwise).
  void resultCountEl.offsetWidth;
  resultCountEl.classList.add('pop');
}

// A live interactive session already has an open terminal elsewhere, and
// a session whose liveness couldn't be confirmed might secretly be one
// too — acting on either has no safe use, and doing so against a real
// live session has previously destabilized other unrelated live sessions
// on the same machine. Pulled out of renderRow so the exact same
// disabled/label/title logic can drive the inline Attach button
// childLinkHtml puts on a parent row, not just the row's own button.
function computeAction(session) {
  const alreadyOpen = session.live && session.kind === 'interactive';
  // Not a safety concern the way liveUnknown is (see server.mjs's
  // canSafelyAct) — disabled anyway because resuming is exactly the
  // action that would grow this old transcript further, defeating the
  // point of having retired it in favor of the newer same-named session.
  const disabled = alreadyOpen || session.liveUnknown || session.superseded;
  const label = alreadyOpen
    ? 'Already open elsewhere'
    : session.superseded
    ? 'Moved to a newer session'
    : session.liveUnknown
    ? (session.pidConfirmedAlive ? 'Running elsewhere' : 'Status unknown')
    : session.live
    ? 'Attach'
    : 'Resume';
  // Attach joins a session that's already running — it must never look
  // like a second, equally-weighted "launch" button next to Resume, or it
  // reads as "click to start another copy of this." Left unfilled/outlined
  // instead of solid for that reason; the title spells out the difference
  // for anyone who still isn't sure from the style alone.
  const actionClass = disabled ? 'btn-secondary' : session.live ? 'btn-attach' : 'btn-primary';
  const actionTitle = alreadyOpen
    ? 'This session already has an open terminal elsewhere'
    : session.superseded
    ? "Retired — resuming would grow the old transcript this session's name was moved off of"
    : session.liveUnknown
    ? (session.pidConfirmedAlive
      ? "Confirmed still running elsewhere, but claude agents isn't reporting it — refusing to act"
      : 'Liveness could not be confirmed, so every action is refused')
    : session.live
    ? 'Opens a terminal joined to this already-running session — does not start a new one'
    : 'Opens a new terminal and resumes this session';
  return { disabled, label, actionClass, actionTitle };
}

// A parent session that parked a background job under it (see
// mergeSessions.mjs) has no useful action of its own — Claude Code has no
// CLI mechanism to attach to a live interactive terminal, only to a
// background job — so the one thing worth surfacing here is the child's
// own already-working action, plus enough of its status that "running
// elsewhere" doesn't read as something wrong. Reuses computeAction
// exactly as the child's own row would, rather than re-deriving it.
function childLinkHtml(child, sessionsById) {
  const { disabled, label, actionClass, actionTitle } = computeAction(child);
  return `
    <div class="row-child-link">
      <span class="child-link-summary">⤷ background job: <strong>${escapeHtml(statusLabel(child, sessionsById))}</strong></span>
      <button class="btn ${actionClass}" data-action="child-attach" title="${escapeHtml(actionTitle)}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>
      <button class="link-toggle" data-action="toggle-child" type="button" aria-expanded="false">▸ details</button>
    </div>
    <div class="child-detail hidden"></div>
  `;
}

function renderRow(row, session, sessionsById) {
  const { disabled, label, actionClass, actionTitle } = computeAction(session);
  // A session can only be purged once it's confirmed dead — never live,
  // never liveUnknown (same fail-closed reasoning as the resume guard,
  // but stricter: purging a live background session's files out from
  // under it has no safe analog to "attach", so there is no exception).
  const canPurge = !session.live && !session.liveUnknown;
  // Mirrors server.mjs's canPause (session.live && canSafelyAct(session))
  // — this is only the client-side half of that defense; the server
  // re-resolves the session itself and re-checks independently before
  // ever running `claude stop`. Only a live background job has a
  // stoppable id at all, so this and canPurge are mutually exclusive and
  // never both render on the same row.
  const canPause = session.live && !session.liveUnknown && !session.superseded
    && session.kind === 'background' && typeof session.id === 'string' && session.id.length > 0;
  // Close is Pause's counterpart for a live interactive session (mirrors
  // server.mjs's canClose) — the one case Resume/Attach always disables
  // outright (alreadyOpen, above) and canPause never covers, since an
  // interactive session has no id. Ends the process by pid instead of a
  // native Claude Code verb, since none exists for this case — see
  // docs/2026-09-13-pause-session-design.md's addendum.
  const canClose = session.live && !session.liveUnknown && !session.superseded
    && session.kind === 'interactive' && typeof session.pid === 'number';
  const sizeLabel = formatSize(session.sizeBytes);
  const child = session.childSessionId ? sessionsById?.get(session.childSessionId) : null;

  // The row (and any armed confirm state) is about to be torn down and
  // rebuilt below — an in-flight "click again to confirm" window must not
  // survive that, or a later first click on the freshly-rendered button
  // could be mistaken for the second, confirming click. Callers with an
  // active timer for this session skip calling renderRow at all (see
  // renderSessions) specifically so this line is never reached while
  // armed — this is just the fallback for every other case.
  clearPurgeConfirm(session.sessionId);
  clearPauseConfirm(session.sessionId);
  clearCloseConfirm(session.sessionId);
  row.classList.toggle('superseded-row', Boolean(session.superseded));

  row.innerHTML = `
    <span class="row-status pill ${statusClass(session, sessionsById)}">${escapeHtml(statusLabel(session, sessionsById))}</span>
    <div class="row-main">
      <div class="row-top">
        <span class="row-name">${escapeHtml(session.name)}</span>
        <span class="row-when muted">${relativeTime(session.updatedAt)}</span>
      </div>
      <div class="row-sub muted" title="${escapeHtml(session.cwd)}">
        <span class="row-cwd">${escapeHtml(session.cwd)}</span>
        <span class="badge">${session.kind === 'background' ? 'background' : 'interactive'}</span>
        ${child ? '<span class="badge badge-role">parent</span>' : ''}
        ${session.gitBranch ? `<span>· ${escapeHtml(session.gitBranch)}</span>` : ''}
        ${sizeLabel ? `<span>· ${sizeLabel}</span>` : ''}
      </div>
      ${child ? childLinkHtml(child, sessionsById) : ''}
      ${session.preview ? `<p class="row-preview">${escapeHtml(session.preview)}</p>` : ''}
      ${activityStripHtml(session)}
      ${expiryBadgeHtml(session)}
      <div class="row-id muted" title="Session ID">${escapeHtml(session.sessionId)}</div>
    </div>
    <div class="row-actions">
      <button class="btn ${actionClass}" data-action="resume" title="${escapeHtml(actionTitle)}" ${disabled ? 'disabled' : ''}>
        ${label}
      </button>
      <button class="icon-btn" data-action="copy" title="${COPY_LABEL}" aria-label="${COPY_LABEL}">${COPY_ICON}</button>
      ${canPause ? `<button class="icon-btn icon-btn-pause" data-action="pause" title="${PAUSE_LABEL}" aria-label="${PAUSE_LABEL}">${PAUSE_ICON}</button>` : ''}
      ${canClose ? `<button class="icon-btn icon-btn-close" data-action="close" title="${CLOSE_LABEL}" aria-label="${CLOSE_LABEL}">${CLOSE_ICON}</button>` : ''}
      ${canPurge ? `<button class="icon-btn icon-btn-danger" data-action="purge" title="${DELETE_LABEL}" aria-label="${DELETE_LABEL}">${TRASH_ICON}</button>` : ''}
    </div>
  `;
  if (!disabled) {
    row.querySelector('[data-action="resume"]').addEventListener('click', () => resumeSession(session, row));
  }
  row.querySelector('[data-action="copy"]').addEventListener('click', (event) => copyResumeCommand(session, event.currentTarget));
  if (canPause) {
    row.querySelector('[data-action="pause"]').addEventListener('click', (event) => handlePauseClick(session, event.currentTarget));
  }
  if (canClose) {
    row.querySelector('[data-action="close"]').addEventListener('click', (event) => handleCloseClick(session, event.currentTarget));
  }
  if (canPurge) {
    row.querySelector('[data-action="purge"]').addEventListener('click', (event) => handlePurgeClick(session, event.currentTarget));
  }
  // Re-collapses on every rebuild (a signature change resets .child-detail
  // to its empty template state) rather than preserving expansion across
  // polls — accepted for now: this pair changes rarely enough in practice
  // that re-expanding costs one extra click, not a redesign.
  if (child) {
    const toggle = row.querySelector('[data-action="toggle-child"]');
    const detail = row.querySelector('.child-detail');
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.textContent = expanded ? '▸ details' : '▾ hide';
      detail.classList.toggle('hidden', expanded);
      if (!expanded && detail.childElementCount === 0) {
        const childRow = buildRow(child, sessionsById);
        // The child can share its parent's exact name (Claude Code lets a
        // background job inherit the interactive session's own name) —
        // confirmed confusing 2026-09-14: two identically-named rows
        // stacked with no marker reading as unrelated duplicates rather
        // than one linked pair.
        childRow.querySelector('.row-sub')?.insertAdjacentHTML(
          'afterbegin',
          '<span class="badge badge-role">background job</span>'
        );
        detail.appendChild(childRow);
      }
    });
    const inlineAttach = row.querySelector('[data-action="child-attach"]');
    if (inlineAttach && !inlineAttach.disabled) {
      inlineAttach.addEventListener('click', (event) => resumeChildInline(child, event.currentTarget));
    }
  }
}

function buildRow(session, sessionsById) {
  const row = document.createElement('article');
  row.className = 'session-row';
  row.dataset.key = sessionKey(session);
  renderRow(row, session, sessionsById);
  return row;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

// The universal fallback for the terminal-spawn path (see app header
// comment): served over http://127.0.0.1, where navigator.clipboard
// normally works, but it must not be assumed — a non-secure context or a
// user gesture edge case can still leave it undefined or make it reject.
// resumeCommand comes from the server once the parallel API-payload change
// lands; until then (and for any session it's missing on) this falls back
// to the plain CLI invocation every session supports.
async function copyResumeCommand(session, button) {
  const text = session.resumeCommand || `claude --resume ${session.sessionId}`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    if (!legacyCopyToClipboard(text)) {
      showToast('Could not copy — no clipboard access in this browser');
      button.classList.add('shake');
      button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
      return;
    }
  }
  showToast(`Copied resume command for ${session.name}`);
}

// document.execCommand('copy') is deprecated but still the only fallback
// when the async Clipboard API is missing or refuses (e.g. no secure
// context) — an offscreen textarea is the standard workaround.
function legacyCopyToClipboard(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

// Only sessionId is sent — the server resolves cwd/live/kind/id itself
// from its own current session list rather than trusting this object,
// which may be a few seconds stale from the last poll. Shared between
// resumeSession (a real row to rebuild afterward) and resumeChildInline
// (the summary button on a parent row, with no row of its own).
async function postResume(sessionId) {
  const res = await fetch('/api/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(await res.text());
}

// row is the caller's own element to rebuild afterward — not re-derived
// via rowsByKey, since a nested child row (rendered inside a parent's
// row when expanded — see childLinkHtml's toggle) is a real, attached
// element that was never added to rowsByKey at all.
async function resumeSession(session, row) {
  const button = row.querySelector('[data-action="resume"]');
  button.disabled = true;
  button.textContent = '…';
  let succeeded = true;
  try {
    await postResume(session.sessionId);
    showToast(`Opening terminal for ${session.name}…`);
    button.textContent = '✓ Opened';
    button.classList.add('btn-flash-success');
  } catch {
    succeeded = false;
    showToast(`Failed to resume ${session.name}`);
    button.textContent = '✕ Failed';
    button.classList.add('shake');
  }
  // A held moment for the success/failure feedback above to actually be
  // seen before renderRow() rebuilds the button back to its normal state —
  // calling renderRow immediately (the old behavior) wiped both in the
  // same tick they were added, so neither was ever visible.
  await new Promise((resolve) => setTimeout(resolve, succeeded ? 700 : 500));
  renderRow(row, session);
}

// The inline Attach button on a parent row (childLinkHtml) has no row of
// its own to rebuild — the child isn't rendered as a row at all unless
// expanded — so this gives the same network call and toast feedback,
// scoped to just the button itself.
async function resumeChildInline(child, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '…';
  try {
    await postResume(child.sessionId);
    showToast(`Opening terminal for ${child.name}…`);
    button.textContent = '✓ Opened';
    button.classList.add('btn-flash-success');
  } catch {
    showToast(`Failed to resume ${child.name}`);
    button.textContent = '✕ Failed';
    button.classList.add('shake');
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  button.disabled = false;
  button.textContent = original;
  button.classList.remove('btn-flash-success', 'shake');
}

async function purgeSession(session, button) {
  button.disabled = true;
  button.classList.remove('armed');
  button.innerHTML = SPINNER_ICON;
  try {
    const res = await fetch('/api/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    showToast(`Moved ${session.name} to trash`);
    // rawSessions/refreshView() only run once the row has actually left the
    // DOM — updating them first would make renderSessions() drop the row
    // from the list on this same tick, skipping the leave animation this
    // was supposed to play. refreshView() afterward also covers the case
    // where this was the last row matching the current filters: the
    // "no sessions match" message needs to appear now, not on the next poll.
    const finishRemoval = () => {
      rowsByKey.delete(session.sessionId);
      rowSignatures.delete(session.sessionId);
      if (rawSessions) {
        rawSessions = rawSessions.filter((s) => s.sessionId !== session.sessionId);
      }
      refreshView();
    };
    const row = rowsByKey.get(session.sessionId);
    if (!row) {
      finishRemoval();
    } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // A row that just vanishes reads as an error, not a completed action
      // — normally it animates out first, matching the same intent the two
      // clicks already signaled. Reduced-motion users get that animation
      // disabled in CSS, which means animationend would never fire — skip
      // straight to removal for them instead of leaving a dead row stuck
      // in the list forever.
      row.remove();
      finishRemoval();
    } else {
      row.classList.add('row-leaving');
      row.addEventListener('animationend', () => {
        row.remove();
        finishRemoval();
      }, { once: true });
    }
  } catch {
    showToast(`Failed to move ${session.name} to trash`);
    button.disabled = false;
    button.innerHTML = TRASH_ICON;
    button.title = DELETE_LABEL;
    button.setAttribute('aria-label', DELETE_LABEL);
    button.classList.add('shake');
    button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
  }
}

// Two-click confirmation shared by purge, pause, and close: the first
// click arms a short window during which a second click on the same
// button actually fires the action. Arming briefly disables the button so
// a fast, accidental double-click can't land both clicks before a person
// could realistically react to the visual change. aria-label is updated
// alongside title — an aria-label, once present, takes over the
// accessible name entirely, so updating only `title` (as a mouse-hover
// tooltip) would be invisible to keyboard/screen-reader users. A hover
// tooltip alone is easy to miss entirely (you have to hover AND wait) —
// user feedback 2026-09-13: also surface armToast as a real toast so the
// "click again" instruction doesn't depend on noticing a tooltip at all.
function handleConfirmClick({ timers, session, button, normalLabel, armToast, onConfirm }) {
  const key = session.sessionId;
  if (timers.has(key)) {
    clearConfirmTimer(timers, key);
    onConfirm();
    return;
  }

  showToast(armToast);
  button.title = CONFIRM_LABEL;
  button.setAttribute('aria-label', CONFIRM_LABEL);
  button.classList.add('armed', 'shake');
  button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
  button.disabled = true;
  setTimeout(() => {
    if (timers.has(key)) button.disabled = false;
  }, 400);
  const timerId = setTimeout(() => {
    timers.delete(key);
    button.title = normalLabel;
    button.setAttribute('aria-label', normalLabel);
    button.classList.remove('armed');
    button.disabled = false;
  }, 5000);
  timers.set(key, timerId);
}

function handlePurgeClick(session, button) {
  handleConfirmClick({
    timers: purgeConfirmTimers,
    session,
    button,
    normalLabel: DELETE_LABEL,
    armToast: `Click the trash icon again to permanently delete ${session.name}`,
    onConfirm: () => purgeSession(session, button),
  });
}

function handlePauseClick(session, button) {
  handleConfirmClick({
    timers: pauseConfirmTimers,
    session,
    button,
    normalLabel: PAUSE_LABEL,
    armToast: `Click the pause icon again to stop ${session.name} — it stays resumable`,
    onConfirm: () => pauseSession(session, button),
  });
}

function handleCloseClick(session, button) {
  handleConfirmClick({
    timers: closeConfirmTimers,
    session,
    button,
    normalLabel: CLOSE_LABEL,
    armToast: `Click the power icon again to close ${session.name} — its terminal stays open, resume it anytime`,
    onConfirm: () => closeSession(session, button),
  });
}

// Unlike purgeSession's optimistic local removal (a file move this client
// already knows succeeded), pausing changes what `claude agents` itself
// reports — real external state this client hasn't polled yet — so success
// triggers a real refetch instead of guessing the row's new shape locally.
async function pauseSession(session, button) {
  button.disabled = true;
  button.classList.remove('armed');
  button.innerHTML = SPINNER_ICON;
  try {
    const res = await fetch('/api/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    showToast(`Paused ${session.name} — resume it anytime, right where it left off`);
    refreshNow();
  } catch {
    showToast(`Failed to pause ${session.name}`);
    button.disabled = false;
    button.innerHTML = PAUSE_ICON;
    button.title = PAUSE_LABEL;
    button.setAttribute('aria-label', PAUSE_LABEL);
    button.classList.add('shake');
    button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
  }
}

// Same reasoning as pauseSession: a real refetch, not a local guess, since
// whether the session actually ended is real state this client hasn't
// polled yet. The session's own terminal window stays open at a normal
// prompt (verified live — see lib/closeSession.mjs) — only its process
// tree ends, so there's nothing else for this client to reflect beyond
// the row dropping out of live.
async function closeSession(session, button) {
  button.disabled = true;
  button.classList.remove('armed');
  button.innerHTML = SPINNER_ICON;
  try {
    const res = await fetch('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
    showToast(`Closed ${session.name} — its terminal stays open, resume it anytime`);
    refreshNow();
  } catch {
    showToast(`Failed to close ${session.name}`);
    button.disabled = false;
    button.innerHTML = CLOSE_ICON;
    button.title = CLOSE_LABEL;
    button.setAttribute('aria-label', CLOSE_LABEL);
    button.classList.add('shake');
    button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
  }
}

function renderSkeleton() {
  sessionListEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'session-row skeleton';
    sessionListEl.appendChild(skeleton);
  }
}

function renderSessions(sessions, sessionsById) {
  // renderSkeleton() appends placeholder rows directly to the list without
  // registering them in rowsByKey, since they represent no real session.
  // Clear them here so they don't linger after the first successful load.
  sessionListEl.querySelectorAll('.skeleton').forEach((el) => el.remove());

  const seenKeys = new Set();
  sessions.forEach((session, index) => {
    const key = sessionKey(session);
    seenKeys.add(key);
    let row = rowsByKey.get(key);
    const signature = sessionSignature(session, sessionsById);
    if (row) {
      // A row with an armed purge- or pause-confirm timer is left
      // untouched: a routine poll or filter change re-rendering it from
      // scratch would call clearPurgeConfirm()/clearPauseConfirm()/
      // clearCloseConfirm() (top of renderRow) and rebuild a fresh,
      // unarmed button, silently defeating the two-click confirmation the
      // user is mid-way through.
      if (purgeConfirmTimers.has(key) || pauseConfirmTimers.has(key) || closeConfirmTimers.has(key)) {
        // leave as-is
      } else if (rowSignatures.get(key) !== signature) {
        renderRow(row, session, sessionsById);
        rowSignatures.set(key, signature);
      } else {
        // Nothing about the session changed — skip the full rebuild (the
        // fix for the every-poll flash) but still advance the "X ago"
        // text, which is derived from wall-clock time rather than
        // anything in the signature.
        const whenEl = row.querySelector('.row-when');
        if (whenEl) whenEl.textContent = relativeTime(session.updatedAt);
      }
    } else {
      row = buildRow(session, sessionsById);
      row.style.animationDelay = `${index * 30}ms`;
      rowsByKey.set(key, row);
      rowSignatures.set(key, signature);
    }
    // appendChild on a node that's already exactly where it belongs is
    // still a real DOM mutation as far as the browser is concerned — it
    // retriggers this row's CSS enter animation, which is what caused the
    // whole list to visibly flash on every single poll even though most
    // rows' relative order never actually changes between polls. Only
    // move a row when it isn't already sitting at its correct index.
    if (sessionListEl.children[index] !== row) {
      sessionListEl.appendChild(row);
    }
  });

  for (const [key, row] of rowsByKey) {
    if (!seenKeys.has(key)) {
      row.remove();
      rowsByKey.delete(key);
      rowSignatures.delete(key);
    }
  }
}

// Runs entirely against the last-fetched rawSessions — called both after a
// poll and after any filter control changes, so narrowing a filter never
// waits on a network round trip. Filter controls are live from page load,
// before the first /api/sessions response arrives — bail out rather than
// render an empty list on top of the loading skeleton in that window.
function refreshView() {
  if (rawSessions === null) return;
  const total = rawSessions.length;
  const sessionsById = new Map(rawSessions.map((s) => [s.sessionId, s]));
  const filtered = applyFilters(rawSessions, sessionsById);
  // A child whose parent also survived the current filters is folded into
  // the parent's own row (see childLinkHtml) instead of appearing a
  // second time as its own top-level row. It still counts toward the
  // shown/total tally below — nesting is a display choice, not a filter —
  // and if the parent itself didn't survive filtering, the child still
  // renders normally on its own.
  const filteredIds = new Set(filtered.map((s) => s.sessionId));
  const visible = filtered.filter((s) => !(s.parentSessionId && filteredIds.has(s.parentSessionId)));
  updateResultCount(filtered.length, total);
  renderSessions(visible, sessionsById);
  emptyEl.classList.toggle('hidden', total > 0);
  noMatchesEl.classList.toggle('hidden', !(total > 0 && filtered.length === 0));
}

function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span>A newer version of ResumerAgent is running on the server.</span>
    <button id="update-reload-btn">Reload</button>
  `;
  document.body.prepend(banner);
  document.getElementById('update-reload-btn').addEventListener('click', () => location.reload());
}

async function loadSessions() {
  refreshIconEl.classList.add('spinning');
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(await res.text());
    const payload = await res.json();
    if (knownServerStartedAt === null) {
      knownServerStartedAt = payload.startedAt;
    } else if (payload.startedAt !== knownServerStartedAt) {
      // The server this tab is talking to restarted (new code deployed,
      // or the launcher replaced a stale instance) since this page loaded.
      // This tab's own app.js is now the stale part — no fetch of new data
      // will ever surface new UI, since the rendering code itself is old.
      showUpdateBanner();
    }
    rawSessions = payload.sessions;
    renderStats(payload.stats);
    const liveStatusBannerEl = document.getElementById('live-status-banner');
    liveStatusBannerEl.classList.toggle('hidden', !payload.liveStatusError);
    liveStatusBannerEl.textContent = payload.liveStatusError
      ? `Can't check which sessions are live, so every row shows "Status unknown" and actions stay locked. Claude Code CLI error: ${payload.liveStatusError}`
      : '';
    errorEl.classList.add('hidden');
    refreshView();
    // Store the actual fetch time — computing relativeTime(Date.now())
    // at render time is always "just now" by construction and silently
    // hides a feed that's stopped updating (caught in the final review).
    lastRefreshedAt = Date.now();
    lastRefreshedEl.textContent = `updated ${relativeTime(lastRefreshedAt)}`;
    pulseHeartbeat();
  } catch {
    if (firstLoad) {
      sessionListEl.innerHTML = '';
      errorEl.classList.remove('hidden');
    } else if (lastRefreshedAt) {
      // A poll failure after the first successful load must be visible,
      // not silent — acting on stale liveness data is exactly the kind
      // of mistake this project exists to design out of.
      lastRefreshedEl.textContent = `stale · last updated ${relativeTime(lastRefreshedAt)}`;
    }
  } finally {
    firstLoad = false;
    refreshIconEl.classList.remove('spinning');
  }
}

function setActiveChip(when) {
  filterWhenEl.querySelectorAll('.chip').forEach((chip) => {
    const isActive = chip.dataset.when === when;
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-checked', String(isActive));
  });
}

// Reflects the 3 status checkboxes onto the "All" master checkbox: fully
// checked, fully unchecked, or indeterminate (native tri-state rendering —
// a dash instead of a check) when they're mixed.
function syncStatusAllCheckbox() {
  const boxes = Array.from(statusCheckboxes);
  const checkedCount = boxes.filter((b) => b.checked).length;
  statusAllEl.checked = checkedCount === boxes.length;
  statusAllEl.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
}

function clearFilters() {
  filterState.search = '';
  filterState.when = 'all';
  filterState.statuses = new Set(STATUS_KEYS);
  filterState.sortBy = 'createdAt-desc';
  filterSearchEl.value = '';
  sortSelectEl.value = 'createdAt-desc';
  setActiveChip('all');
  statusCheckboxes.forEach((box) => { box.checked = true; });
  syncStatusAllCheckbox();
  refreshView();
}

filterSearchEl.addEventListener('input', () => {
  filterState.search = filterSearchEl.value.trim().toLowerCase();
  refreshView();
});

filterWhenEl.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  filterState.when = chip.dataset.when;
  setActiveChip(filterState.when);
  refreshView();
});

statusCheckboxes.forEach((box) => {
  box.addEventListener('change', () => {
    filterState.statuses = new Set(
      Array.from(statusCheckboxes).filter((b) => b.checked).map((b) => b.dataset.status)
    );
    syncStatusAllCheckbox();
    refreshView();
  });
});

statusAllEl.addEventListener('change', () => {
  const checkAll = statusAllEl.checked;
  statusCheckboxes.forEach((box) => { box.checked = checkAll; });
  filterState.statuses = new Set(checkAll ? Array.from(statusCheckboxes).map((b) => b.dataset.status) : []);
  statusAllEl.indeterminate = false;
  refreshView();
});

sortSelectEl.addEventListener('change', () => {
  filterState.sortBy = sortSelectEl.value;
  refreshView();
});

document.getElementById('clear-filters-btn').addEventListener('click', clearFilters);
document.getElementById('clear-filters-inline-btn').addEventListener('click', clearFilters);

let pollTimer;

async function shutdownServer() {
  const button = document.getElementById('shutdown-btn');
  button.disabled = true;
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch {
    // The server closing its socket mid-response can surface as a fetch
    // error even though the shutdown itself succeeded — either way, the
    // next line stops polling a server we just told to stop existing.
  }
  clearTimeout(pollTimer);
  document.body.innerHTML = `
    <div class="empty">
      ResumerAgent has been shut down.<br />
      Relaunch it from the desktop shortcut when you need it again.
    </div>
  `;
}

const THEME_STORAGE_KEY = 'resumeragent-theme';
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function syncThemeButton() {
  const isLight = document.documentElement.dataset.theme === 'light';
  const title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
  themeToggleBtn.title = title;
  themeToggleBtn.setAttribute('aria-label', title);
}

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_STORAGE_KEY, next);
  syncThemeButton();
});
syncThemeButton();

// setTimeout-chained rather than setInterval so a manual refresh can push
// the next automatic one back out to a full POLL_INTERVAL_MS away, instead
// of an unrelated interval tick landing seconds later — the whole point of
// a manual refresh button once the interval is minutes long, not seconds.
async function pollAndReschedule() {
  await loadSessions();
  pollTimer = setTimeout(pollAndReschedule, POLL_INTERVAL_MS);
}

function refreshNow() {
  clearTimeout(pollTimer);
  pollAndReschedule();
}

document.getElementById('refresh-btn').addEventListener('click', refreshNow);
document.getElementById('retry-btn').addEventListener('click', refreshNow);
document.getElementById('shutdown-btn').addEventListener('click', shutdownServer);

renderSkeleton();
pollAndReschedule();
