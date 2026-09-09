import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

const MAX_TAIL_BYTES = 200_000;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

// Claude Code stores several kinds of synthetic/injected content under the
// same "user" role as things you actually typed: tool/system output tags
// (<local-command-stdout>, <system-reminder>, ...), bracket-wrapped
// artifacts ([Image: ...], [Request interrupted...]), the auto-compaction
// summary banner, and a skill's own invocation preamble. None of these are
// something a person typed, so none of them should stand in as a preview
// or a fallback session name. This list is a best effort, not exhaustive —
// worst case a message here slips through and shows a slightly odd
// preview, nothing else breaks.
const SYNTHETIC_TEXT_PREFIXES = [
  '<',
  '[',
  'This session is being continued from a previous conversation',
  'Base directory for this skill:',
];

function isSyntheticText(text) {
  return SYNTHETIC_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

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
      if (!firstLine || isSyntheticText(firstLine)) continue;
      return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return null;
}
