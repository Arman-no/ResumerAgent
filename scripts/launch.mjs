import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, 'server.mjs');
const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Pure parsing/decision helpers — exported for scripts/launch.test.mjs.
// Nothing below this block touches the OS; it only ever reads strings and
// an injectable clock, so a test can exercise it without a real process,
// a real port, or a real timer.
// ---------------------------------------------------------------------------

// netstat's STATE column is localized ("LISTENING" in English, "ABHÖREN" on
// German Windows, and so on), but the column *position* and the fact that a
// listening socket's foreign address is always 0.0.0.0:0 (or [::]:0 for
// IPv6, never a real peer address) are not translated — matching on that
// shape instead of the STATE text finds the right row on every Windows UI
// language without enumerating translations.
export function parseNetstatPid(output, targetPort) {
  const suffix = `:${targetPort}`;
  for (const line of String(output ?? '').split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'TCP') continue;
    const [, localAddress, foreignAddress, , pid] = columns;
    if (!localAddress || !localAddress.endsWith(suffix)) continue;
    if (foreignAddress !== '0.0.0.0:0' && foreignAddress !== '[::]:0') continue;
    if (pid) return pid;
  }
  return null;
}

// lsof -ti already prints bare pids, one per line — nothing to decode.
export function parseLsofPids(output) {
  return String(output ?? '').trim().split('\n')[0] || null;
}

// Confirms a candidate pid is actually running *this* repo's server.mjs
// before anything downstream is allowed to kill it — the fix for the
// original bug of killing any node.exe found holding the port. The spawn()
// call at the bottom of this file invokes the server as a bare relative
// arg (its cwd is already REPO_ROOT), so that's the command line shape to
// expect back from the OS for a real instance of this launcher; an
// absolute path is also accepted, but only if it resolves to this repo's
// own server.mjs, not a same-named file elsewhere.
// ponytail: a bare "server.mjs" argument is accepted without checking the
// owning process's actual working directory — Windows has no simple
// dependency-free way to query another process's cwd (unlike POSIX's
// /proc/<pid>/cwd). Residual risk: an unrelated app also literally named
// server.mjs, invoked the same relative way, happens to be on the same
// port. Upgrade by shelling out to a cwd-aware tool (e.g. Sysinternals
// handle.exe) if that ever causes a real false positive.
export function isOurServer(commandLine, serverPath = SERVER_PATH) {
  if (!commandLine) return false;
  const tokens = String(commandLine).match(/"[^"]*"|\S+/g) ?? [];
  const scriptArg = tokens
    .map((token) => token.replace(/^"|"$/g, ''))
    .find((token) => /(^|[\\/])server\.mjs$/i.test(token));
  if (!scriptArg) return false;
  if (!path.isAbsolute(scriptArg)) return true;
  return path.resolve(scriptArg).toLowerCase() === String(serverPath).toLowerCase();
}

// Bounded wait for an async condition — used on POSIX after SIGTERM so the
// new server doesn't race the old one for the port (fix for finding c:
// starting immediately risked an EADDRINUSE). Deadline/sleep/clock are all
// injectable so the retry/deadline arithmetic is testable without a real
// timer or a real port.
export async function waitUntil(check, {
  timeoutMs = 5000,
  intervalMs = 200,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// OS-calling wrappers — thin on purpose (same convention as the pre-existing
// probeInstalled in lib/terminalCommand.mjs): not unit tested themselves,
// only the decision logic they delegate to above is.
// ---------------------------------------------------------------------------

function findListeningPid(targetPort) {
  if (!isWindows) {
    try {
      const output = execFileSync('lsof', ['-ti', `tcp:${targetPort}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      });
      return parseLsofPids(output);
    } catch {
      return null;
    }
  }
  try {
    const output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    return parseNetstatPid(output, targetPort);
  } catch {
    return null;
  }
}

// Windows: query the owning process's command line via CIM — the same data
// Task Manager's "Command line" column shows, obtained read-only and
// without an extra dependency. POSIX: `ps -o args=` is the equivalent.
function getCommandLine(pid) {
  if (!/^\d+$/.test(String(pid))) return null;
  try {
    if (isWindows) {
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8' }
      ).trim();
    }
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// Returns false when the port is occupied by something this script must
// not touch — caller is responsible for not starting a new server in that
// case.
async function stopStaleInstance(port) {
  const pid = findListeningPid(port);
  if (!pid) return true;

  const commandLine = getCommandLine(pid);
  if (!isOurServer(commandLine)) {
    console.warn(
      `Port ${port} is already in use by another process (PID ${pid}, "${commandLine ?? 'unknown command'}") — leaving it alone.`
    );
    return false;
  }

  console.log(`Stopping previous ResumerAgent instance (PID ${pid})...`);
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGTERM');
      await waitUntil(() => !findListeningPid(port));
    }
  } catch {
    // Already gone between the check above and here — fine, that's the
    // outcome we wanted anyway.
  }
  return true;
}

async function main() {
  const { port } = loadConfig();

  if (!(await stopStaleInstance(port))) {
    process.exitCode = 1;
    return;
  }

  spawn(process.execPath, ['server.mjs'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: false,
  });
}

// Only run the launcher when this file is executed directly (`node
// scripts/launch.mjs` / `npm run launch`) — never on import, which is how
// scripts/launch.test.mjs reaches the pure functions above without ever
// touching a real port or a real process.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
