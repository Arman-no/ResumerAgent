import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Zero-dependency .env reader — no `dotenv` package (this project has no
// required runtime dependencies), and Node's built-in --env-file flag
// would tie the `start` script to a specific Node version floor. Real
// process.env values still win over .env (spread order below), matching
// the usual dotenv convention of "shell overrides file".
function loadDotEnv(dir = REPO_ROOT) {
  let content;
  try {
    content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

export function loadConfig(env = process.env) {
  const merged = { ...loadDotEnv(), ...env };

  const sessionsRoot = merged.SESSIONS_ROOT
    || merged.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');

  const resumeCommand = merged.RESUME_COMMAND
    || 'cd /d "{cwd}" && claude --resume {sessionId}';

  const attachCommand = merged.ATTACH_COMMAND
    || 'claude attach {id}';

  const port = Number.parseInt(merged.PORT, 10) || 4317;

  return { sessionsRoot, resumeCommand, attachCommand, port };
}
