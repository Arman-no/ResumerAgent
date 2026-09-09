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

// Claude Code writes its own end-of-turn "recap" as a
// {type:"system", subtype:"away_summary", content:"..."} line — a
// purpose-written summary of what actually happened, strictly better as a
// preview than the last thing the user happened to type (which might be
// as bare as "check spot1", with no indication of what came of it). It's
// checked in the same backward scan as the last-typed-message fallback
// below, so whichever is more recent in the file wins — a recap is
// normally written after the triggering user message, so it naturally
// takes priority when one exists.
const RECAP_HINT_SUFFIX = ' (disable recaps in /config)';

function extractRecap(line) {
  if (line.type !== 'system' || line.subtype !== 'away_summary') return null;
  if (typeof line.content !== 'string') return null;
  let cleaned = line.content.replace(ANSI_ESCAPE_PATTERN, '').trim();
  if (cleaned.endsWith(RECAP_HINT_SUFFIX)) {
    cleaned = cleaned.slice(0, -RECAP_HINT_SUFFIX.length).trim();
  }
  return cleaned || null;
}

// A `/rename` writes {type:"custom-title", customTitle:"..."} directly
// into the transcript itself. That's what makes it recoverable at all
// once a session is dead: the sessions/*.json registry pointer — the
// *other* place a name could live — gets deleted on a clean exit, same as
// always. Real use hit this: a session renamed via `/rename`, then closed
// cleanly, went right back to showing "No Name" — the rename was real and
// persisted, just not anywhere the dead-session path was looking.

// Preferred when the caller already knows the transcript's real path (e.g.
// lib/discoverSessions.mjs, which found it by walking the filesystem
// directly) — avoids re-deriving it through encodeCwdForProjectDir's
// best-effort, potentially-lossy guess a second time for no reason.
// Returns {preview, customName} — either may be null.
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
    return { preview: null, customName: null };
  }

  const lines = raw.split('\n').filter(Boolean);
  let preview = null;
  let customName = null;
  // Keeps scanning backward past the first preview match, up to the full
  // tail window, so a rename that happened earlier than the most recent
  // message/recap still gets picked up — stops early only once both are
  // found, since nothing further back can improve either at that point.
  for (let i = lines.length - 1; i >= 0 && !(preview && customName); i--) {
    let line;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!customName && line.type === 'custom-title' && typeof line.customTitle === 'string') {
      const trimmed = line.customTitle.trim();
      if (trimmed) customName = trimmed;
    }

    if (preview) continue;

    const recap = extractRecap(line);
    if (recap) {
      preview = recap.length > 140 ? `${recap.slice(0, 140)}…` : recap;
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
      preview = firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return { preview, customName };
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
