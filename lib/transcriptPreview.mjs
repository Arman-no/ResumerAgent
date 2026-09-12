import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

// 200_000 was plenty when this only had to find the last real message for a
// preview (always within the last few KB). cost-state lines are written
// much less often — periodically, not once per turn — so on a long-running
// session the last one measured 300-500KB from the end on real transcripts
// on this machine. 2MB comfortably covers that with margin; a session
// inactive long enough that even its last checkpoint sits further back
// than this just shows no cost data yet rather than crashing — ponytail:
// a fixed cap, not a search-until-found scan; raise it again (or add a
// second, larger fallback read) if this stops being enough.
const MAX_TAIL_BYTES = 2_000_000;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

// ponytail: every Claude model on the API currently tops out at 200k
// (aside from a 1M-context beta header this tool has no way to detect from
// a transcript alone) — good enough for the green/yellow/red band this
// feeds, not a promise of an exact percentage. Upgrade path: read the
// actual limit from `message.model` if/when transcripts start recording it.
const CONTEXT_WINDOW_TOKENS = 200_000;

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
// Returns {preview, customName, costUsd, contextUsedPercent} — any may be
// null. costUsd/contextUsedPercent ride along in this same tail scan
// (rather than a second file read) since Claude Code already writes both
// signals into the transcript itself:
//   - a {"type":"cost-state", totalCostUSD, ...} line appended after each
//     turn, carrying the session's own cumulative cost (same number the
//     statusline's cost.total_cost_usd shows) — no per-model pricing table
//     needed, it's already computed for us.
//   - each assistant message's own message.usage — input_tokens +
//     cache_creation_input_tokens + cache_read_input_tokens approximates
//     how much of the context window that turn's request actually used.
// Rate-limit data has no transcript equivalent at all (confirmed against
// docs/2026-09-12-activity-observability-design.md) — only the statusline
// JSON payload carries rate_limits.*, which is why that piece is sourced
// from lib/rateLimitSidecar.mjs instead, optionally, not from here.
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
    return { preview: null, customName: null, costUsd: null, contextUsedPercent: null };
  }

  const lines = raw.split('\n').filter(Boolean);
  let preview = null;
  let customName = null;
  let costUsd = null;
  let contextUsedPercent = null;
  // Keeps scanning backward past the first preview/costUsd match, up to
  // the full tail window, so a rename or cost-state further back than the
  // most recent message still gets picked up. costUsd specifically needs
  // to be in this exit condition, not just contextUsedPercent — Claude
  // Code auto-retitles a session periodically (its own "ai-title" entries
  // land a custom-title right near the end almost every turn), so
  // `customName` alone is found almost immediately on real transcripts,
  // which would otherwise stop the scan long before it ever reaches back
  // to the last cost-state line (confirmed on a real transcript: the last
  // rename sat 18KB from the end, the last cost-state 433KB back — an
  // early exit gated on customName alone silently returned costUsd: null
  // even though the file had it).
  for (let i = lines.length - 1; i >= 0 && !(preview && customName && costUsd !== null); i--) {
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

    if (costUsd === null && line.type === 'cost-state' && typeof line.totalCostUSD === 'number') {
      costUsd = line.totalCostUSD;
    }

    if (contextUsedPercent === null && line.type === 'assistant' && line.message?.usage) {
      const u = line.message.usage;
      const usedTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (usedTokens > 0) contextUsedPercent = Math.min(100, (usedTokens / CONTEXT_WINDOW_TOKENS) * 100);
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
  return { preview, customName, costUsd, contextUsedPercent };
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
