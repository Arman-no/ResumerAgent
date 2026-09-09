import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

const MAX_TAIL_BYTES = 200_000;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

export function readTranscriptPreview(sessionsRoot, cwd, sessionId) {
  const file = path.join(
    sessionsRoot,
    'projects',
    encodeCwdForProjectDir(cwd),
    `${sessionId}.jsonl`
  );

  let raw;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    raw = buffer.toString('utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let line;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (line.type !== 'user' || !line.message?.content) continue;

    const content = line.message.content;
    const text = Array.isArray(content)
      ? content.find((c) => c.type === 'text')?.text
      : typeof content === 'string' ? content : null;

    if (text) {
      const cleaned = text.replace(ANSI_ESCAPE_PATTERN, '');
      const firstLine = cleaned.split('\n')[0].trim();
      // Claude Code stores tool/system output under the same "user" role
      // (e.g. <local-command-stdout>, <system-reminder>) — these aren't
      // what the person actually typed, so skip them and keep scanning
      // backward for a real message instead of surfacing them as-is.
      if (!firstLine || firstLine.startsWith('<')) continue;
      return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return null;
}
