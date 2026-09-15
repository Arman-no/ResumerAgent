import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envWithoutIdentity } from './cleanEnv.mjs';

const execFileAsync = promisify(execFile);

// Root-caused live 2026-09-12: `claude agents --json --all` measured
// 2.2s-6.3s on a real machine with ~8-11 tracked sessions (it enumerates
// every live agent, so cost grows with session count). At 5000ms, this
// timed out often enough that readLiveAgents() returned null and every
// session on the dashboard showed "status unknown" / the live-count stat
// read 0 — not a merge/render bug, mergeSessions.mjs's liveUnknown
// cascade (see its own comment) is working exactly as designed for a
// failed liveness check. Fix is headroom here, not a fallback downstream.
const TIMEOUT_MS = 15000;

// agents is null (not []) on any failure — null means "could not determine
// liveness", which callers must treat as unknown, not as "nothing is
// live". Conflating the two let a slow/failed CLI call make a genuinely
// live interactive session look safely dead (caught in the final review).
// error is a one-line reason for the dashboard to show, since "Status
// unknown" on every row says nothing about why.
// command/args are overridable only so tests can stand in a fake CLI
// without touching real Claude Code sessions; every real caller uses the
// defaults.
export async function readLiveAgents(command = 'claude', args = ['agents', '--json', '--all']) {
  try {
    // Flagged by a code review of the Resume/Attach env-stripping fix:
    // this call inherited process.env unstripped, meaning the exact same
    // ambient identity markers could scope or filter its output under
    // the identical condition that fix exists for — and this call's
    // output is what canSafelyAct() ultimately gates Resume/Attach/Purge
    // safety decisions on. Stripped the same way, for the same reason.
    const { stdout } = await execFileAsync(
      command,
      args,
      { shell: true, windowsHide: true, timeout: TIMEOUT_MS, env: envWithoutIdentity() }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed)
      ? { agents: parsed, error: null }
      : { agents: null, error: 'claude agents --json --all returned something other than a list' };
  } catch (err) {
    console.error(
      err.code === 'ENOENT'
        ? 'readLiveAgents: "claude" not found on PATH — is Claude Code CLI installed?'
        : 'readLiveAgents failed:',
      err.code === 'ENOENT' ? '' : err
    );
    return { agents: null, error: describeFailure(err) };
  }
}

// The CLI's own first line is the useful part: a broken install ("not
// compatible with the version of Windows") looks nothing like a timeout.
function describeFailure(err) {
  if (err.code === 'ENOENT') return '"claude" not found on PATH — is Claude Code CLI installed?';
  if (err.killed) return `timed out after ${TIMEOUT_MS / 1000}s`;
  return String(err.stderr || err.message).trim().split(/\r?\n/)[0] || 'failed with no error output';
}
