const POLL_INTERVAL_MS = 5000;

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const lastRefreshedEl = document.getElementById('last-refreshed');
const toastEl = document.getElementById('toast');

const cardsByKey = new Map();
let firstLoad = true;

function sessionKey(s) {
  return s.sessionId;
}

function statusLabel(session) {
  return session.live ? `live · ${session.status}` : 'resumable';
}

function statusClass(session) {
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
  return `${days}d ago`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderCard(card, session) {
  // A live interactive session already has an open terminal elsewhere.
  // Resuming it anyway has no safe use, and doing so against a real live
  // session has previously destabilized other unrelated live sessions on
  // the same machine — so this button is genuinely disabled (no click
  // handler attached at all), not just styled as secondary. The server
  // enforces the same rule independently in /api/resume; this is the
  // client-side half of that defense, not the only one.
  const alreadyOpen = session.live && session.kind === 'interactive';
  card.innerHTML = `
    <div class="card-header">
      <h2 class="card-name">${escapeHtml(session.name)}</h2>
      <span class="pill ${statusClass(session)}">${escapeHtml(statusLabel(session))}</span>
    </div>
    <div class="card-cwd" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</div>
    <div class="card-meta">
      <span class="badge">${session.kind === 'background' ? 'background' : 'interactive'}</span>
      <span class="muted">${relativeTime(session.updatedAt)}</span>
    </div>
    ${session.preview ? `<p class="card-preview">${escapeHtml(session.preview)}</p>` : ''}
    <div class="card-actions">
      <button class="btn ${alreadyOpen ? 'btn-secondary' : 'btn-primary'}" data-action="resume" ${alreadyOpen ? 'disabled' : ''}>
        ${alreadyOpen ? 'Already open elsewhere' : session.live ? 'Attach' : 'Resume'}
      </button>
    </div>
  `;
  if (!alreadyOpen) {
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
    const res = await fetch('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
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
    lastRefreshedEl.textContent = `updated ${relativeTime(Date.now())}`;
  } catch {
    if (firstLoad) {
      grid.innerHTML = '';
      errorEl.classList.remove('hidden');
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
