import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envWithoutIdentity } from './cleanEnv.mjs';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 10000;

// There is no native Claude Code verb for stopping an interactive session
// (`claude stop` only works on a background job, see pauseSession.mjs) —
// an interactive session's terminal has no external stop surface at all.
// A direct process kill is the only mechanism that exists, so this is
// that one deliberate exception to "never reinvent what Claude Code
// already owns."
//
// Verified live 2026-09-13, against real sessions on this machine:
// - The standard signal-based Ctrl+C and a raw-keystroke console-input
//   injection BOTH failed to stop a real interactive session — it reads
//   through a pseudo-console layer for its keyboard handling that
//   neither reaches. No graceful in-band way to ask it to exit exists.
// - Ending only the top-level PID is not enough: an interactive session
//   spawns its own LSP/MCP helper processes (pyright, the ruflo MCP
//   server, Playwright's MCP server) several process-levels deep as real
//   descendants of its own PID (traced live: e.g. a session's pyright
//   server was a grandchild of that session's own claude.exe). Ending
//   only the parent leaves those orphaned and still consuming memory —
//   the whole point of Close. The tree-scoped form below ends the entire
//   descendant tree; it never touches ancestors, so the session's own
//   parent cmd.exe window is untouched.
// - Confirmed the surviving cmd.exe window stays usable: ending the
//   child does not leave its console stuck in a broken raw-input state —
//   Windows/cmd.exe resets the console's input mode back to normal
//   (echo, line input, processed input) on its own once its child exits.
//   No manual console-mode fixup needed.
//
// isStillClaudeProcess guards the one real remaining risk: PID reuse. The
// server re-derives session state fresh right before calling this (same
// pattern as every other action here), so the window is small, but
// acting on a PID that's been silently recycled into an unrelated
// process has no safe undo — worth the one extra check.
//
// No `shell: true` here (unlike pauseSession.mjs/liveAgents.mjs, which
// need it to reach a `claude` .cmd shim) — confirmed live 2026-09-13 that
// it actively breaks this specific call: the filter value has to survive
// as ONE argument ("PID eq 12345"), and cmd.exe's own re-tokenizing of
// the joined command line under shell:true was splitting it back into
// three, which tasklist then rejected outright ("Invalid argument/option
// - 'eq'"). Passing the array straight to CreateProcess avoids that
// entirely. Real callers never need argsPrefix; tests use it to point at
// a `node <fake-script>` stand-in without needing a shell to parse it.
async function isStillClaudeProcess(pid, command, argsPrefix) {
  const { stdout } = await execFileAsync(
    command,
    [...argsPrefix, '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { windowsHide: true, timeout: TIMEOUT_MS, env: envWithoutIdentity() }
  );
  return stdout.toLowerCase().includes('claude.exe');
}

export async function closeInteractiveSession(pid, overrides = {}) {
  const {
    tasklistCommand = 'tasklist',
    tasklistArgsPrefix = [],
    taskkillCommand = 'taskkill',
    taskkillArgsPrefix = [],
  } = overrides;

  if (!(await isStillClaudeProcess(pid, tasklistCommand, tasklistArgsPrefix))) {
    throw new Error(`PID ${pid} is no longer a claude.exe process — refusing to act on a possibly-reused PID`);
  }

  try {
    await execFileAsync(taskkillCommand, [...taskkillArgsPrefix, '/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: TIMEOUT_MS,
      env: envWithoutIdentity(),
    });
  } catch (err) {
    // `/T` fails its overall exit code if ANY descendant in the tree
    // can't be ended — including one that already exited on its own
    // between enumeration and the kill attempt. Confirmed live
    // 2026-09-13: a real helper process raced this way ("no running
    // instance of the task" for just that one child), yet the actual
    // target pid was already gone — the real goal had already been
    // reached. What matters is whether the target itself is gone, not
    // whether every descendant got a signal from this specific call.
    const targetStillRunning = await isStillClaudeProcess(pid, tasklistCommand, tasklistArgsPrefix);
    if (targetStillRunning) throw err;
  }
}
