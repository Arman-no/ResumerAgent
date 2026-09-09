import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readLiveAgents() {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['agents', '--json', '--all'],
      { shell: true, windowsHide: true, timeout: 5000 }
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
