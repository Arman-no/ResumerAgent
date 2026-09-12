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

// Returns null (not []) on any failure — null means "could not determine
// liveness", which callers must treat as unknown, not as "nothing is
// live". Conflating the two let a slow/failed CLI call make a genuinely
// live interactive session look safely dead (caught in the final review).
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
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    // Every session then shows "Status unknown" with every action refused —
    // a colleague missing the `claude` CLI (or with an older one lacking
    // --all) gets that with no clue why. ENOENT is the one cause worth
    // naming explicitly; the rest still get logged, just without a guess.
    console.error(
      err.code === 'ENOENT'
        ? 'readLiveAgents: "claude" not found on PATH — is Claude Code CLI installed?'
        : 'readLiveAgents failed:',
      err.code === 'ENOENT' ? '' : err
    );
    return null;
  }
}
