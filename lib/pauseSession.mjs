import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envWithoutIdentity } from './cleanEnv.mjs';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 15000;

// `claude stop <id>` is Claude Code's own native lifecycle command for a
// background session — not an OS-level kill by PID. Its own --help text:
// "Stop a background session. Its conversation is kept: `claude attach
// <id>` opens it again, `claude --resume` works once it is stopped." That
// makes it the honest implementation of "pause": real, already-safe, and
// already resumable, rather than this app inventing its own process-kill
// logic (which on Windows can't even send a real signal — process.kill
// with anything but 0 unconditionally force-terminates). There is no
// equivalent for an interactive session: it IS a terminal someone has
// open, and Claude Code exposes no external stop surface for that at all
// — server.mjs's canPause() only ever calls this for a background session
// with a known id, the same shape Attach already requires.
export async function pauseBackgroundSession(id, command = 'claude') {
  await execFileAsync(command, ['stop', id], {
    shell: true,
    windowsHide: true,
    timeout: TIMEOUT_MS,
    env: envWithoutIdentity(),
  });
}
