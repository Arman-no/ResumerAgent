import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Returns null (not []) on any failure — null means "could not determine
// liveness", which callers must treat as unknown, not as "nothing is
// live". Conflating the two let a slow/failed CLI call make a genuinely
// live interactive session look safely dead (caught in the final review).
export async function readLiveAgents() {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['agents', '--json', '--all'],
      { shell: true, windowsHide: true, timeout: 5000 }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
