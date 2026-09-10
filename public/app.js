const POLL_INTERVAL_MS = 5000;

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
const SPINNER_ICON = `<span class="btn-icon-spinner"></span>`;

const DELETE_LABEL = 'Delete session';
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

// sessionId -> pending confirm-window timeout, for the two-click purge
// confirmation below.
const purgeConfirmTimers = new Map();

function clearPurgeConfirm(sessionId) {
  const timerId = purgeConfirmTimers.get(sessionId);
  if (timerId) {
    clearTimeout(timerId);
    purgeConfirmTimers.delete(sessionId);
  }
}

function sessionKey(s) {
  return s.sessionId;
}

// Deliberately excludes nothing — every field here is something a real
// rebuild should react to. relativeTime() is handled separately (see
// renderSessions) precisely so it can keep advancing every poll without
// needing a signature change, rather than being baked in here and forcing
// a full rebuild every 5 seconds purely because time passed.
function sessionSignature(session) {
  return JSON.stringify(session);
}

// The four states filterable in the sidebar — distinct from statusLabel
// below, which additionally shows *what* a live session is doing
// (idle/busy/waiting). Filtering only needs the coarser live/resumable/
// unknown/superseded split. superseded is checked first: it's a subset of
// what would otherwise read as "resumable" (not live, liveness confirmed),
// but nothing useful can be done with it besides purge, so it gets its own
// filter instead of being silently lumped in with genuinely-resumable ones.
function statusKey(session) {
  if (session.superseded) return 'superseded';
  if (session.liveUnknown) return 'unknown';
  return session.live ? 'live' : 'resumable';
}

function statusLabel(session) {
  if (session.superseded) return 'moved to a newer session';
  if (session.liveUnknown) return session.pidConfirmedAlive ? 'running elsewhere' : 'status unknown';
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session) {
  if (session.superseded) return 'status-superseded';
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

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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

function applyFilters(sessions) {
  return sessions
    .filter((s) =>
      filterState.statuses.has(statusKey(s)) &&
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

function renderRow(row, session) {
  // A live interactive session already has an open terminal elsewhere,
  // and a session whose liveness couldn't be confirmed might secretly be
  // one too — acting on either has no safe use, and doing so against a
  // real live session has previously destabilized other unrelated live
  // sessions on the same machine. This button is genuinely disabled (no
  // click handler attached at all), not just styled as secondary. The
  // server enforces the same rule independently and is the load-bearing
  // check (it re-resolves the session itself rather than trusting this
  // client) — this is only the client-side half of that defense.
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
  // A session can only be purged once it's confirmed dead — never live,
  // never liveUnknown (same fail-closed reasoning as the resume guard,
  // but stricter: purging a live background session's files out from
  // under it has no safe analog to "attach", so there is no exception).
  const canPurge = !session.live && !session.liveUnknown;
  const sizeLabel = formatSize(session.sizeBytes);

  // The row (and any armed confirm state) is about to be torn down and
  // rebuilt below — an in-flight "click again to confirm" window must not
  // survive that, or a later first click on the freshly-rendered button
  // could be mistaken for the second, confirming click. Callers with an
  // active timer for this session skip calling renderRow at all (see
  // renderSessions) specifically so this line is never reached while
  // armed — this is just the fallback for every other case.
  clearPurgeConfirm(session.sessionId);
  row.classList.toggle('superseded-row', Boolean(session.superseded));

  row.innerHTML = `
    <span class="row-status pill ${statusClass(session)}">${escapeHtml(statusLabel(session))}</span>
    <div class="row-main">
      <div class="row-top">
        <span class="row-name">${escapeHtml(session.name)}</span>
        <span class="row-when muted">${relativeTime(session.updatedAt)}</span>
      </div>
      <div class="row-sub muted" title="${escapeHtml(session.cwd)}">
        <span class="row-cwd">${escapeHtml(session.cwd)}</span>
        <span class="badge">${session.kind === 'background' ? 'background' : 'interactive'}</span>
        ${session.gitBranch ? `<span>· ${escapeHtml(session.gitBranch)}</span>` : ''}
        ${sizeLabel ? `<span>· ${sizeLabel}</span>` : ''}
      </div>
      ${session.preview ? `<p class="row-preview">${escapeHtml(session.preview)}</p>` : ''}
      <div class="row-id muted" title="Session ID">${escapeHtml(session.sessionId)}</div>
    </div>
    <div class="row-actions">
      <button class="btn ${actionClass}" data-action="resume" title="${escapeHtml(actionTitle)}" ${disabled ? 'disabled' : ''}>
        ${label}
      </button>
      ${canPurge ? `<button class="icon-btn icon-btn-danger" data-action="purge" title="${DELETE_LABEL}" aria-label="${DELETE_LABEL}">${TRASH_ICON}</button>` : ''}
    </div>
  `;
  if (!disabled) {
    row.querySelector('[data-action="resume"]').addEventListener('click', () => resumeSession(session));
  }
  if (canPurge) {
    row.querySelector('[data-action="purge"]').addEventListener('click', (event) => handlePurgeClick(session, event.currentTarget));
  }
}

function buildRow(session) {
  const row = document.createElement('article');
  row.className = 'session-row';
  row.dataset.key = sessionKey(session);
  renderRow(row, session);
  return row;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

async function resumeSession(session) {
  const row = rowsByKey.get(session.sessionId);
  const button = row.querySelector('[data-action="resume"]');
  button.disabled = true;
  button.textContent = '…';
  let succeeded = true;
  try {
    // Only sessionId is sent — the server resolves cwd/live/kind/id itself
    // from its own current session list rather than trusting this object,
    // which may be a few seconds stale from the last poll.
    const res = await fetch('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    if (!res.ok) throw new Error(await res.text());
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

// Two-click confirmation: the first click arms a short window during
// which a second click on the same button actually purges. Arming briefly
// disables the button so a fast, accidental double-click can't land both
// clicks before a person could realistically react to the visual change.
// aria-label is updated alongside title — an aria-label, once present,
// takes over the accessible name entirely, so updating only `title` (as a
// mouse-hover tooltip) would be invisible to keyboard/screen-reader users.
function handlePurgeClick(session, button) {
  const key = session.sessionId;
  if (purgeConfirmTimers.has(key)) {
    clearPurgeConfirm(key);
    purgeSession(session, button);
    return;
  }

  button.title = CONFIRM_LABEL;
  button.setAttribute('aria-label', CONFIRM_LABEL);
  button.classList.add('armed', 'shake');
  button.addEventListener('animationend', () => button.classList.remove('shake'), { once: true });
  button.disabled = true;
  setTimeout(() => {
    if (purgeConfirmTimers.has(key)) button.disabled = false;
  }, 400);
  const timerId = setTimeout(() => {
    purgeConfirmTimers.delete(key);
    button.title = DELETE_LABEL;
    button.setAttribute('aria-label', DELETE_LABEL);
    button.classList.remove('armed');
    button.disabled = false;
  }, 5000);
  purgeConfirmTimers.set(key, timerId);
}

function renderSkeleton() {
  sessionListEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'session-row skeleton';
    sessionListEl.appendChild(skeleton);
  }
}

function renderSessions(sessions) {
  // renderSkeleton() appends placeholder rows directly to the list without
  // registering them in rowsByKey, since they represent no real session.
  // Clear them here so they don't linger after the first successful load.
  sessionListEl.querySelectorAll('.skeleton').forEach((el) => el.remove());

  const seenKeys = new Set();
  sessions.forEach((session, index) => {
    const key = sessionKey(session);
    seenKeys.add(key);
    let row = rowsByKey.get(key);
    const signature = sessionSignature(session);
    if (row) {
      // A row with an armed purge-confirm timer is left untouched: a
      // routine poll or filter change re-rendering it from scratch would
      // call clearPurgeConfirm() (top of renderRow) and rebuild a fresh,
      // unarmed button, silently defeating the two-click confirmation the
      // user is mid-way through.
      if (purgeConfirmTimers.has(key)) {
        // leave as-is
      } else if (rowSignatures.get(key) !== signature) {
        renderRow(row, session);
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
      row = buildRow(session);
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
  const filtered = applyFilters(rawSessions);
  updateResultCount(filtered.length, total);
  renderSessions(filtered);
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
  clearInterval(pollTimer);
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

document.getElementById('refresh-btn').addEventListener('click', loadSessions);
document.getElementById('retry-btn').addEventListener('click', loadSessions);
document.getElementById('shutdown-btn').addEventListener('click', shutdownServer);

renderSkeleton();
loadSessions();
pollTimer = setInterval(loadSessions, POLL_INTERVAL_MS);
