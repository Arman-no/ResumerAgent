import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn } from 'node:child_process';

import { loadConfig } from './lib/config.mjs';
import { readSessionRegistry } from './lib/sessionRegistry.mjs';
import { readLiveAgents } from './lib/liveAgents.mjs';
import { readTranscriptPreview } from './lib/transcriptPreview.mjs';
import { mergeSessions } from './lib/mergeSessions.mjs';
import { buildResumeCommand } from './lib/resumeCommand.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const MAX_BODY_BYTES = 10 * 1024;

const config = loadConfig();

async function getSessionsPayload() {
  const [registryEntries, liveEntries] = await Promise.all([
    Promise.resolve(readSessionRegistry(config.sessionsRoot)),
    readLiveAgents(),
  ]);

  return mergeSessions(
    registryEntries,
    liveEntries,
    (cwd, sessionId) => readTranscriptPreview(config.sessionsRoot, cwd, sessionId)
  );
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
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
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

async function handleResume(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    res.writeHead(413).end('Request body too large');
    return;
  }

  let session;
  try {
    session = JSON.parse(body);
  } catch {
    res.writeHead(400).end('Invalid JSON');
    return;
  }

  if (
    session === null ||
    typeof session !== 'object' ||
    Array.isArray(session) ||
    typeof session.cwd !== 'string' ||
    typeof session.sessionId !== 'string'
  ) {
    res.writeHead(400).end('Invalid session: expected an object with cwd and sessionId');
    return;
  }

  // A session that is already live and interactive already has an open
  // terminal somewhere. There is no safe reason to resume it anyway — doing
  // this against a real live session has been observed to destabilize other
  // unrelated live sessions on the same machine — so it's rejected here
  // regardless of what the client sends, not just discouraged in the UI.
  if (session.live === true && session.kind === 'interactive') {
    res.writeHead(400).end('Refusing to resume a session that is already live and interactive');
    return;
  }

  try {
    const command = buildResumeCommand({
      session,
      resumeTemplate: config.resumeCommand,
      attachTemplate: config.attachCommand,
    });

    const title = sanitizeTitle(session);
    spawn('cmd.exe', ['/c', 'start', title, 'cmd', '/k', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, command }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await getSessionsPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.url === '/api/resume' && req.method === 'POST') {
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

  serveStatic(req, res);
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`;
  console.log(`ResumerAgent dashboard: ${url}`);
  exec(`cmd /c start "" "${url}"`);
});
