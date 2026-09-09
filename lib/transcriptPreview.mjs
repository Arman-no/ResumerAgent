import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

const MAX_TAIL_BYTES = 200_000;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

// Claude Code stores several kinds of synthetic/injected content under the
// same "user" role as things you actually typed: tool/system output tags
// (<local-command-stdout>, <system-reminder>, ...), specific bracket-
// wrapped artifacts ([Image: ...], [Request interrupted...]), the
// auto-compaction summary banner, and a skill's own invocation preamble.
// None of these are something a person typed, so none of them should
// stand in as a preview or a fallback session name. This list is a best
// effort, not exhaustive, in both directions: a synthetic pattern not
// listed here can slip through (worst case, an odd-looking preview — cosmetic
// only), and a real message that happens to start with one of these exact
// strings would be wrongly skipped (worse: this list deliberately does NOT
// include a bare '<' or '[' prefix — an earlier version did, and a bare
// '[' wrongly swallowed real ticket-prefixed messages like
// "[PHOENIX-18579] ..." — so only specific, concrete synthetic prefixes
// are listed, not a whole punctuation class).
const SYNTHETIC_TAG_PATTERN = /^<[A-Za-z][\w-]*>/;
const SYNTHETIC_TEXT_PREFIXES = [
  '[Image:',
  '[Request interrupted',
  'This session is being continued from a previous conversation',
  'Base directory for this skill:',
];

function isSyntheticText(text) {
  return SYNTHETIC_TAG_PATTERN.test(text) || SYNTHETIC_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// Preferred when the caller already knows the transcript's real path (e.g.
// lib/discoverSessions.mjs, which found it by walking the filesystem
// directly) — avoids re-deriving it through encodeCwdForProjectDir's
// best-effort, potentially-lossy guess a second time for no reason.
export function readTranscriptPreviewFromFile(file) {
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

// Fallback for when only cwd/sessionId are known, not the real file path
// (a live session whose transcript discoverSessions.mjs hasn't found
// yet). Re-derives the path via encodeCwdForProjectDir's best-effort
// guess — see that function's own comment for what "best-effort" means
// here; worst case is a missing preview, nothing else breaks.
export function readTranscriptPreview(sessionsRoot, cwd, sessionId) {
  const file = path.join(
    sessionsRoot,
    'projects',
    encodeCwdForProjectDir(cwd),
    `${sessionId}.jsonl`
  );
  return readTranscriptPreviewFromFile(file);
}
