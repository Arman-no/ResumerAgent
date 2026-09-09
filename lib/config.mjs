import os from 'node:os';
import path from 'node:path';

export function loadConfig(env = process.env) {
  const sessionsRoot = env.SESSIONS_ROOT
    || env.CLAUDE_CONFIG_DIR
    || path.join(os.homedir(), '.claude');

  const resumeCommand = env.RESUME_COMMAND
    || 'cd /d "{cwd}" && claude --resume {sessionId}';

  const attachCommand = env.ATTACH_COMMAND
    || 'claude attach {id}';

  const port = Number.parseInt(env.PORT, 10) || 4317;

  return { sessionsRoot, resumeCommand, attachCommand, port };
}
