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

// Claude Code's own cleanup default when the key is absent from
// settings.json — keep in sync with upstream if that default ever changes.
const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

// Same file Claude Code itself reads its cleanupPeriodDays from — no new
// config surface, just following the same settings.json this tool's
// SESSIONS_ROOT already resolves to. Missing/malformed file or key both
// fall back to Claude Code's own documented default, not a guess of ours.
function loadCleanupPeriodDays(sessionsRoot) {
  try {
    const raw = fs.readFileSync(path.join(sessionsRoot, 'settings.json'), 'utf8');
    const value = JSON.parse(raw).cleanupPeriodDays;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  } catch {
    // missing file, unreadable, or not JSON — fall through to the default
  }
  return DEFAULT_CLEANUP_PERIOD_DAYS;
}

export function loadConfig(env = process.env) {
  const merged = { ...loadDotEnv(), ...env };

  const sessionsRoot = merged.SESSIONS_ROOT
    || merged.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');

  // 0 means "cleanup disabled" per Claude Code's own semantics — callers
  // computing days-until-expiry must treat that as "never expires", not
  // as "expires today".
  const cleanupPeriodDays = loadCleanupPeriodDays(sessionsRoot);

  // No `cd /d "{cwd}" &&` prefix here — the working directory is set via
  // the spawned process's own `cwd` option instead (see server.mjs), which
  // `start` then inherits for the new window. Building a working directory
  // change into this string was the root cause of a real "filename,
  // directory name, or volume label syntax is incorrect" bug: cmd.exe
  // parses `&`, `&&`, and unbalanced quote pairs itself at every layer a
  // command string passes through (this template -> spawned via `start` ->
  // a nested `cmd /k`), and there is no quoting scheme that survives all of
  // those layers at once for an arbitrary command. Keeping this template
  // free of shell metacharacters sidesteps the problem entirely rather than
  // trying to out-escape it.
  const resumeCommand = merged.RESUME_COMMAND
    || 'claude --resume {sessionId}';

  const attachCommand = merged.ATTACH_COMMAND
    || 'claude attach {id}';

  const port = Number.parseInt(merged.PORT, 10) || 4317;

  return { sessionsRoot, resumeCommand, attachCommand, port, cleanupPeriodDays };
}
