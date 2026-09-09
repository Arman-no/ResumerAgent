const POLL_INTERVAL_MS = 5000;

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const lastRefreshedEl = document.getElementById('last-refreshed');
const toastEl = document.getElementById('toast');

const cardsByKey = new Map();
let firstLoad = true;
let lastRefreshedAt = null;

function sessionKey(s) {
  return s.sessionId;
}

function statusLabel(session) {
  if (session.liveUnknown) return 'status unknown';
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session) {
  if (session.liveUnknown) return 'status-resumable';
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

function renderCard(card, session) {
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
  const disabled = alreadyOpen || session.liveUnknown;
  const label = alreadyOpen
    ? 'Already open elsewhere'
    : session.liveUnknown
    ? 'Status unknown'
    : session.live
    ? 'Attach'
    : 'Resume';
  card.innerHTML = `
    <div class="card-header">
      <h2 class="card-name">${escapeHtml(session.name)}</h2>
      <span class="pill ${statusClass(session)}">${escapeHtml(statusLabel(session))}</span>
    </div>
    <div class="card-cwd" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</div>
    <div class="card-id" title="Session ID">${escapeHtml(session.sessionId)}</div>
    <div class="card-meta">
      <span class="badge">${session.kind === 'background' ? 'background' : 'interactive'}</span>
      <span class="muted">${relativeTime(session.updatedAt)}</span>
      ${session.gitBranch ? `<span class="muted">· ${escapeHtml(session.gitBranch)}</span>` : ''}
      ${formatSize(session.sizeBytes) ? `<span class="muted">· ${formatSize(session.sizeBytes)}</span>` : ''}
    </div>
    ${session.preview ? `<p class="card-preview">${escapeHtml(session.preview)}</p>` : ''}
    <div class="card-actions">
      <button class="btn ${disabled ? 'btn-secondary' : 'btn-primary'}" data-action="resume" ${disabled ? 'disabled' : ''}>
        ${label}
      </button>
    </div>
  `;
  if (!disabled) {
    card.querySelector('[data-action="resume"]').addEventListener('click', () => resumeSession(session));
  }
}

function buildCard(session) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.key = sessionKey(session);
  renderCard(card, session);
  return card;
}

let toastTimer;
function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

async function resumeSession(session) {
  const card = grid.querySelector(`[data-key="${session.sessionId}"]`);
  const button = card.querySelector('[data-action="resume"]');
  button.disabled = true;
  button.textContent = '…';
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
  } catch {
    showToast(`Failed to resume ${session.name}`);
  } finally {
    renderCard(card, session);
  }
}

function renderSkeleton() {
  grid.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const skeleton = document.createElement('div');
    skeleton.className = 'card skeleton';
    grid.appendChild(skeleton);
  }
}

function renderSessions(sessions) {
  // renderSkeleton() appends placeholder cards directly to #grid without
  // registering them in cardsByKey, since they represent no real session.
  // Clear them here so they don't linger after the first successful load.
  grid.querySelectorAll('.skeleton').forEach((el) => el.remove());

  emptyEl.classList.toggle('hidden', sessions.length > 0);

  const seenKeys = new Set();
  sessions.forEach((session, index) => {
    const key = sessionKey(session);
    seenKeys.add(key);
    let card = cardsByKey.get(key);
    if (card) {
      renderCard(card, session);
    } else {
      card = buildCard(session);
      card.style.animationDelay = `${index * 30}ms`;
      cardsByKey.set(key, card);
      grid.appendChild(card);
    }
  });

  for (const [key, card] of cardsByKey) {
    if (!seenKeys.has(key)) {
      card.remove();
      cardsByKey.delete(key);
    }
  }
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(await res.text());
    const sessions = await res.json();
    errorEl.classList.add('hidden');
    renderSessions(sessions);
    // Store the actual fetch time — computing relativeTime(Date.now())
    // at render time is always "just now" by construction and silently
    // hides a feed that's stopped updating (caught in the final review).
    lastRefreshedAt = Date.now();
    lastRefreshedEl.textContent = `updated ${relativeTime(lastRefreshedAt)}`;
  } catch {
    if (firstLoad) {
      grid.innerHTML = '';
      errorEl.classList.remove('hidden');
    } else if (lastRefreshedAt) {
      // A poll failure after the first successful load must be visible,
      // not silent — acting on stale liveness data is exactly the kind
      // of mistake this project exists to design out of.
      lastRefreshedEl.textContent = `stale · last updated ${relativeTime(lastRefreshedAt)}`;
    }
  } finally {
    firstLoad = false;
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadSessions);
document.getElementById('retry-btn').addEventListener('click', loadSessions);

renderSkeleton();
loadSessions();
setInterval(loadSessions, POLL_INTERVAL_MS);
