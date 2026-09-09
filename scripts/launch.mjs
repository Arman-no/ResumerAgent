import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { port } = loadConfig();

// Windows only ever holds a LISTENING socket for as long as the owning
// process is alive — no lingering TIME_WAIT on the listener itself — so
// finding and killing that one process guarantees the port is free for the
// next line to bind, no manual delay required.
function findListeningPid(targetPort) {
  let output;
  try {
    output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const line = output
    .split('\n')
    .find((l) => l.includes(`:${targetPort} `) && l.includes('LISTENING'));
  if (!line) return null;
  const columns = line.trim().split(/\s+/);
  return columns[columns.length - 1];
}

// Only ever kill a process we've confirmed is node.exe. The port could in
// principle be held by something unrelated to this project; refusing to
// touch anything else means the worst case here is "port stays busy, the
// existing EADDRINUSE friendly-error path in server.mjs still applies" —
// never "an unrelated process got force-killed."
function isNodeProcess(pid) {
  let output;
  try {
    output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    });
  } catch {
    return false;
  }
  return output.toLowerCase().startsWith('"node.exe"');
}

const existingPid = findListeningPid(port);
if (existingPid && isNodeProcess(existingPid)) {
  console.log(`Stopping previous ResumerAgent instance (PID ${existingPid})...`);
  try {
    execFileSync('taskkill', ['/PID', existingPid, '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone between the check above and here — fine, that's the
    // outcome we wanted anyway.
  }
} else if (existingPid) {
  console.warn(
    `Port ${port} is in use by a non-Node process (PID ${existingPid}) — leaving it alone.`
  );
}

spawn(process.execPath, ['server.mjs'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  shell: false,
});
