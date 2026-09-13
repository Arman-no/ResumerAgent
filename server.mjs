import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn } from 'node:child_process';

import { loadConfig } from './lib/config.mjs';
import { discoverSessions } from './lib/discoverSessions.mjs';
import { readSessionRegistry } from './lib/sessionRegistry.mjs';
import { readLiveAgents } from './lib/liveAgents.mjs';
import { readTranscriptPreview, readTranscriptPreviewFromFile } from './lib/transcriptPreview.mjs';
import { mergeSessions } from './lib/mergeSessions.mjs';
import { buildResumeCommand } from './lib/resumeCommand.mjs';
import { purgeSessionFiles } from './lib/purgeSession.mjs';
import { pauseBackgroundSession } from './lib/pauseSession.mjs';
import { closeInteractiveSession } from './lib/closeSession.mjs';
import { envWithoutIdentity } from './lib/cleanEnv.mjs';
import { computeDaysUntilExpiry } from './lib/expiry.mjs';
import { readActivitySidecar } from './lib/activitySidecar.mjs';
import { computeStatsSummary } from './lib/statsSummary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const MAX_BODY_BYTES = 10 * 1024;
const DEFAULT_DISCOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Identifies this specific server process to the client. A browser tab left
// open across a code change keeps running its already-loaded app.js forever
// — nothing about polling /api/sessions makes it re-fetch its own <script>.
// The client compares this against the value it saw on its own last poll
// and prompts a reload the moment they diverge, instead of silently
// rendering new data through old rendering code with no way to notice.
const SERVER_STARTED_AT = Date.now();

const config = loadConfig();
const ALLOWED_HOSTS = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];

// A session shouldn't silently drop out of the dashboard (discovery window)
// before Claude Code's own cleanup would actually delete it (cleanupPeriodDays)
// — otherwise its expiry warning would never get a chance to fire. 0 means
// cleanup is disabled; the 7-day default stands in that case since there's
// no real ceiling to reconcile against.
const DISCOVERY_WINDOW_MS = config.cleanupPeriodDays
  ? Math.max(DEFAULT_DISCOVERY_WINDOW_MS, config.cleanupPeriodDays * 24 * 60 * 60 * 1000)
  : DEFAULT_DISCOVERY_WINDOW_MS;

async function getSessionsPayload() {
  const [transcriptEntries, registryEntries, liveEntries] = await Promise.all([
    Promise.resolve(discoverSessions(config.sessionsRoot, DISCOVERY_WINDOW_MS)),
    Promise.resolve(readSessionRegistry(config.sessionsRoot)),
    readLiveAgents(),
  ]);

  const sessions = mergeSessions(
    transcriptEntries,
    registryEntries,
    liveEntries,
    // entry.filePath is set for transcript-discovered sessions (the real
    // path discoverSessions.mjs already found them at); the live-only
    // fallback branch in mergeSessions.mjs passes an entry with no
    // filePath, since that session's transcript hasn't been discovered.
    (entry) => entry.filePath
      ? readTranscriptPreviewFromFile(entry.filePath)
      : readTranscriptPreview(config.sessionsRoot, entry.cwd, entry.sessionId)
  );

  // Both derived purely from data mergeSessions() already put on each
  // session (updatedAt, sessionId) plus this server's own resolved config —
  // kept out of mergeSessions.mjs itself so that module stays unaware of
  // cleanupPeriodDays/sidecar concerns it has no other reason to know about.
  return sessions.map((session) => {
    // The sidecar (lib/activitySidecar.mjs) is Claude Code's own
    // statusline-computed number, written fresh on every refresh — prefer
    // it over the transcript-tail approximation whenever it's present,
    // including for a live session that hasn't hit a cost-state
    // checkpoint in its transcript yet (transcript parsing alone can't see
    // that far ahead; the sidecar already has it). Falls back to the
    // transcript-derived value for anyone without a statusline sidecar
    // configured at all, which is the common case for most installs.
    const sidecar = readActivitySidecar(config.sessionsRoot, session.sessionId);
    return {
      ...session,
      daysUntilExpiry: computeDaysUntilExpiry(session.updatedAt, config.cleanupPeriodDays),
      costUsd: sidecar?.cost?.total_cost_usd ?? session.costUsd,
      contextUsedPercent: sidecar?.context_window?.used_percentage ?? session.contextUsedPercent,
      rateLimits: sidecar?.rate_limits ?? null,
      // Rate limits have no other source (see the comment above readActivitySidecar's
      // import) so, unlike cost/context, there's no "at least it's this session's own
      // last real turn" fallback freshness to lean on — this is the only signal the UI
      // has for how stale a rate-limit reading might be. Sidecar writes `updated_at` as
      // Unix seconds (its statusline.ps1 writer's own convention); every other timestamp
      // this app hands the frontend (updatedAt, createdAt) is milliseconds, so convert
      // here rather than pushing the unit mismatch onto every consumer.
      rateLimitsUpdatedAt: sidecar?.updated_at ? sidecar.updated_at * 1000 : null,
    };
  });
}

// Binding to 127.0.0.1 only blocks requests from OUTSIDE the machine — it
// does nothing to stop another web page open in the same browser from
// calling this API. A request with no Origin header at all (curl,
// same-origin navigation) is allowed; one with a mismatched Origin is not.
function isRequestAllowed(req) {
  if (!ALLOWED_HOSTS.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_HOSTS.some((host) => origin === `http://${host}`);
}

function serveStatic(req, res) {
  const requestedPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    // This app's own static files change across sessions far more often
    // than any real caching benefit is worth — force every reload to fetch
    // the current version rather than risk a stale disk-cached copy.
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
  }
  return body;
}

function sanitizeTitle(session) {
  const sanitize = (value) => String(value ?? '').replace(/[^A-Za-z0-9 _.-]/g, '');
  const safe = sanitize(session.name);
  const safeFallback = sanitize(session.sessionId);
  return `Claude: ${safe || safeFallback || 'session'}`;
}

// A live session is only ever actioned if it's a background job with a
// real id (claude attach <id> — a view, never a resume). Everything else
// live — interactive, or background missing its id — is refused. This is
// an allowlist of the one proven-safe case, not a blacklist of the one
// known-bad case, so a session shape nobody's thought of yet still fails
// closed. liveUnknown (readLiveAgents() couldn't determine liveness) is
// refused unconditionally, before this check even runs.
function canSafelyAct(session) {
  if (session.liveUnknown) return false;
  // Not a safety guard the way liveUnknown is — resuming an old, renamed-
  // away-from session can't hurt anything. Refused anyway because the
  // whole point of the feature is "don't keep growing this transcript,"
  // and Resume is exactly the action that would do that.
  if (session.superseded) return false;
  if (!session.live) return true;
  return session.kind === 'background' && typeof session.id === 'string' && session.id.length > 0;
}

// Pause is only ever `claude stop <id>` against a live background job —
// the exact same shape Attach already requires (see buildResumeCommand's
// useAttach), so it reuses canSafelyAct's allowlist rather than
// re-deriving it. An interactive session has no id and no external stop
// surface at all, so it always falls through to false here, same as it
// already does for Resume/Attach.
function canPause(session) {
  return session.live && canSafelyAct(session);
}

// Close is Pause's counterpart for an interactive session — the case
// canSafelyAct always refuses (an interactive live session has no `id`
// and no native stop verb). Same liveness/superseded guards as
// canSafelyAct, but the kind check is inverted on purpose: this is the
// one place a real process pid is the target instead of a background
// job's id. See docs/2026-09-13-pause-session-design.md's addendum for
// why a direct process end is the only mechanism that exists here, and
// why it needs the /T (tree) scope lib/closeSession.mjs uses.
function canClose(session) {
  if (session.liveUnknown) return false;
  if (session.superseded) return false;
  if (!session.live) return false;
  return session.kind === 'interactive' && typeof session.pid === 'number';
}

async function handleResume(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody) ||
    typeof requestBody.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid request: expected an object with sessionId');
    return;
  }

  // Everything below comes from the server's own fresh lookup, never from
  // the request body — requestBody.sessionId is only ever a lookup key.
  // This is the fix for the gap the final review found: an earlier
  // version trusted cwd/live/kind straight from the request body, which
  // meant the safety guard below was only as good as whatever the client
  // happened to send.
  const sessions = await getSessionsPayload();
  const session = sessions.find((s) => s.sessionId === requestBody.sessionId);

  if (!session) {
    res.writeHead(404).end('Unknown session');
    return;
  }

  if (!canSafelyAct(session)) {
    res.writeHead(session.liveUnknown ? 409 : 400).end('Refusing to act on this session');
    return;
  }

  try {
    const command = buildResumeCommand({
      session,
      resumeTemplate: config.resumeCommand,
      attachTemplate: config.attachCommand,
    });

    const title = sanitizeTitle(session);
    // Built as one pre-assembled line and handed to shell:true as a single
    // string (no separate args array) rather than an argv array — Node has
    // no reliable way to escape an argv array through three nested layers
    // of cmd.exe parsing (this spawn -> `start` -> the nested `cmd /k`),
    // which is exactly what produced a real "filename, directory name, or
    // volume label syntax is incorrect" failure. The working directory is
    // set via `cwd` below rather than a `cd /d` prefix in the command
    // string, for the same reason — see the comment in lib/config.mjs.
    const fullLine = `start "${title}" cmd /k "${command}"`;
    const child = spawn(fullLine, {
      cwd: session.cwd,
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: envWithoutIdentity(),
    });
    child.on('error', (err) => console.error('Failed to spawn resume terminal:', err));

    // A blocked spawn (AppLocker/EDR refusing to let this process create a
    // child on someone else's machine, not just a missing file) fails via
    // an async 'error' event, never a thrown exception — reachable only
    // caught by a review flagging a handover risk. Node fires that event on
    // its own next tick at the earliest, so racing it against a short delay
    // catches the near-instant "blocked before it even started" case
    // without meaningfully delaying the real-success path.
    const spawnError = await new Promise((resolve) => {
      child.once('error', resolve);
      setTimeout(() => resolve(null), 300);
    });
    child.unref();

    if (spawnError) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to open terminal: ${spawnError.message}` }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, command }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function handlePurge(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody) ||
    typeof requestBody.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid request: expected an object with sessionId');
    return;
  }

  // Same server-side lookup pattern as /api/resume — the body's sessionId
  // is only ever a key into our own fresh view, never a path or any other
  // trusted field. Purging is stricter than resuming: a live background
  // session can safely be attached to, but there is no safe reason to
  // ever move a live session's files, so any live (or unconfirmed-dead)
  // session is refused outright, full stop.
  const sessions = await getSessionsPayload();
  const session = sessions.find((s) => s.sessionId === requestBody.sessionId);

  if (!session) {
    res.writeHead(404).end('Unknown session');
    return;
  }

  if (session.liveUnknown || session.live) {
    res.writeHead(session.liveUnknown ? 409 : 400).end('Refusing to purge a live or unconfirmed-dead session');
    return;
  }

  try {
    const result = purgeSessionFiles(config.sessionsRoot, session);
    if (result.moved.length === 0) {
      // Found the session in the merged list but its files weren't where
      // we expected — never report success for a mutation that didn't
      // actually happen.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session files not found on disk; nothing was moved' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, movedTo: result.movedTo }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function handlePause(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody) ||
    typeof requestBody.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid request: expected an object with sessionId');
    return;
  }

  // Same server-side lookup pattern as /api/resume and /api/purge — the
  // body's sessionId is only ever a key into our own fresh view.
  const sessions = await getSessionsPayload();
  const session = sessions.find((s) => s.sessionId === requestBody.sessionId);

  if (!session) {
    res.writeHead(404).end('Unknown session');
    return;
  }

  if (!canPause(session)) {
    res.writeHead(session.liveUnknown ? 409 : 400).end('Refusing to pause this session');
    return;
  }

  try {
    await pauseBackgroundSession(session.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function handleClose(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let requestBody;
  try {
    requestBody = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    requestBody === null ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody) ||
    typeof requestBody.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid request: expected an object with sessionId');
    return;
  }

  const sessions = await getSessionsPayload();
  const session = sessions.find((s) => s.sessionId === requestBody.sessionId);

  if (!session) {
    res.writeHead(404).end('Unknown session');
    return;
  }

  if (!canClose(session)) {
    res.writeHead(session.liveUnknown ? 409 : 400).end('Refusing to close this session');
    return;
  }

  try {
    await closeInteractiveSession(session.pid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// Closing a browser tab doesn't touch the server process at all — it's
// independent, launched from its own console window, and stays up until
// that window closes or something tells it to stop. This is the "tell it
// to stop" path: no body, no session lookup, just a deliberate action the
// dashboard itself exposes so there's always a way to fully power it down
// without hunting for the console window.
function handleShutdown(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  console.log('Shutdown requested from the dashboard — stopping ResumerAgent.');
  server.close();
  // server.close() only stops accepting new connections; it waits for
  // existing keep-alive sockets to end before actually resolving, which for
  // a page held open with a live poll loop can hang indefinitely. Nothing
  // here needs a graceful drain, so force the exit shortly after regardless.
  setTimeout(() => process.exit(0), 200);
}

const server = http.createServer(async (req, res) => {
  if (!isRequestAllowed(req)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.url === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await getSessionsPayload();
      // Computed over every session this dashboard currently sees, not the
      // client's filtered/sorted view — the stat cards are meant to answer
      // "what's true across everything," independent of whatever the
      // sidebar filters happen to be narrowed to right now.
      const stats = computeStatsSummary(sessions);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ startedAt: SERVER_STARTED_AT, sessions, stats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.url === '/api/resume' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') {
      res.writeHead(415).end('Unsupported Content-Type');
      return;
    }
    try {
      await handleResume(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.url === '/api/purge' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') {
      res.writeHead(415).end('Unsupported Content-Type');
      return;
    }
    try {
      await handlePurge(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.url === '/api/pause' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') {
      res.writeHead(415).end('Unsupported Content-Type');
      return;
    }
    try {
      await handlePause(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
    return;
  }

  if (req.url === '/api/close' && req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') {
      res.writeHead(415).end('Unsupported Content-Type');
      return;
    }
    try {
      await handleClose(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    }
    return;
  }
  if (req.url === '/api/shutdown' && req.method === 'POST') {
    handleShutdown(req, res);
    return;
  }

  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `ResumerAgent is already running at http://127.0.0.1:${config.port} — open that in your browser, or close the existing instance before starting another.`
    );
  } else {
    console.error('Failed to start ResumerAgent:', err);
  }
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`ResumerAgent dashboard: ${url}`);
  exec(`cmd /c start "" "${url}"`, (err) => {
    if (err) console.error('Failed to open browser:', err);
  });
});
