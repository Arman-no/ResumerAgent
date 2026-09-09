import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envWithoutIdentity } from './cleanEnv.mjs';

const execFileAsync = promisify(execFile);

// Returns null (not []) on any failure — null means "could not determine
// liveness", which callers must treat as unknown, not as "nothing is
// live". Conflating the two let a slow/failed CLI call make a genuinely
// live interactive session look safely dead (caught in the final review).
export async function readLiveAgents() {
  try {
    // Flagged by a code review of the Resume/Attach env-stripping fix:
    // this call inherited process.env unstripped, meaning the exact same
    // ambient identity markers could scope or filter its output under
    // the identical condition that fix exists for — and this call's
    // output is what canSafelyAct() ultimately gates Resume/Attach/Purge
    // safety decisions on. Stripped the same way, for the same reason.
    const { stdout } = await execFileAsync(
      'claude',
      ['agents', '--json', '--all'],
      { shell: true, windowsHide: true, timeout: 5000, env: envWithoutIdentity() }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
