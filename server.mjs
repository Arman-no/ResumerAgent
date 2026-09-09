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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const MAX_BODY_BYTES = 10 * 1024;
const DISCOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Identifies this specific server process to the client. A browser tab left
// open across a code change keeps running its already-loaded app.js forever
// — nothing about polling /api/sessions makes it re-fetch its own <script>.
// The client compares this against the value it saw on its own last poll
// and prompts a reload the moment they diverge, instead of silently
// rendering new data through old rendering code with no way to notice.
const SERVER_STARTED_AT = Date.now();

const config = loadConfig();
const ALLOWED_HOSTS = [`127.0.0.1:${config.port}`, `localhost:${config.port}`];

async function getSessionsPayload() {
  const [transcriptEntries, registryEntries, liveEntries] = await Promise.all([
    Promise.resolve(discoverSessions(config.sessionsRoot, DISCOVERY_WINDOW_MS)),
    Promise.resolve(readSessionRegistry(config.sessionsRoot)),
    readLiveAgents(),
  ]);

  return mergeSessions(
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
  if (!session.live) return true;
  return session.kind === 'background' && typeof session.id === 'string' && session.id.length > 0;
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
    spawn(fullLine, {
      cwd: session.cwd,
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
      .on('error', (err) => console.error('Failed to spawn resume terminal:', err))
      .unref();

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ startedAt: SERVER_STARTED_AT, sessions }));
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
