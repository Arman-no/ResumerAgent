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

// cost-state lines are rare enough that the newest one can sit many MB
// before EOF (confirmed on real transcripts: 7.2MB back on a 28.8MB file,
// 10.3MB back on a 13.5MB file) - past MAX_TAIL_BYTES. Rather than read the
// whole file to find it, walk backward from the tail boundary in chunks,
// string-searching for the marker and parsing only the matching line.
const COST_STATE_MARKER = '"type":"cost-state"';
const COST_STATE_SCAN_CHUNK_BYTES = 4_000_000;

// Session transcript files are append-only: once (path, size, mtimeMs)
// stop changing between polls - true for every non-live session, i.e. most
// of them - the file's content, and therefore this whole result, cannot
// have changed either. Skips the tail read AND the cost-state backward
// scan entirely for those. A live session's size/mtime changes every poll
// anyway, so it never benefits and never needs explicit invalidation.
// ponytail: unbounded Map, no eviction - bounded in practice by how many
// distinct session files exist on disk; add an LRU cap if that stops being true.
const previewCache = new Map();

// Parses only the single matching line, not the whole chunk - a cost-state
// line split across a chunk's left edge is simply skipped (rare: one exact
// byte offset out of a multi-MB file) and the next chunk further back still
// finds it cleanly.
function scanBackwardForCostState(fd, tailStart) {
  let chunkEnd = tailStart;
  while (chunkEnd > 0) {
    const chunkStart = Math.max(0, chunkEnd - COST_STATE_SCAN_CHUNK_BYTES);
    const buffer = Buffer.alloc(chunkEnd - chunkStart);
    fs.readSync(fd, buffer, 0, buffer.length, chunkStart);
    const text = buffer.toString('utf8');
    let searchEnd = text.length;
    for (;;) {
      const markerIdx = text.lastIndexOf(COST_STATE_MARKER, searchEnd - 1);
      if (markerIdx === -1) break;
      const lineStart = text.lastIndexOf('\n', markerIdx) + 1;
      if (lineStart === 0 && chunkStart > 0) {
        // line's start got cut off by this chunk's left edge - not a clean read
        searchEnd = markerIdx;
        continue;
      }
      const newlineAfter = text.indexOf('\n', markerIdx);
      const lineEnd = newlineAfter === -1 ? text.length : newlineAfter;
      try {
        const parsed = JSON.parse(text.slice(lineStart, lineEnd));
        if (typeof parsed.totalCostUSD === 'number') return parsed.totalCostUSD;
      } catch {
        // malformed/truncated - try an earlier match in this same chunk
      }
      searchEnd = markerIdx;
    }
    chunkEnd = chunkStart;
  }
  return null;
}

// Claude Code transcripts DO record `message.model` on every assistant
// turn (verified against real transcripts on this machine — every
// "type":"assistant" line carries one) — the blind 200k-for-everyone
// constant this replaced was wrong for any session run on a
// current-generation model, where 1M is the *default* context window, not
// an opt-in beta: confirmed against a real statusline-sidecar payload for
// a live "claude-sonnet-5" session on this machine
// (activity/<id>.json: context_window.context_window_size: 1000000) and
// against the claude-api skill's cached model catalog.
// Everything NOT in this list (Haiku 4.5, and every legacy/deprecated
// model before this generation) defaults to 200k. Some of those legacy
// models also *offer* a 1M beta, but it's a request-time header, never
// written into the transcript, so there's no way to detect it after the
// fact — 200k is each of those models' own real, undoctored baseline, not
// a guess standing in for the beta case.
// ponytail: a hand-maintained prefix list, not a live Models API lookup —
// this tool reads transcripts offline with no API key configured. Add a
// prefix here when a new model generation ships with 1M as its default.
const EXTENDED_CONTEXT_MODEL_PREFIXES = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-fable-5', 'claude-mythos-5', // covers the -5 and -5-1 variants of each
];

// Returns null (not a guessed number) when `model` is missing or
// unrecognized — the caller treats that the same as "no context data on
// this turn" and keeps scanning backward, rather than rendering a
// percentage against a window size it doesn't actually know.
function contextWindowTokensForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  return EXTENDED_CONTEXT_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? 1_000_000
    : 200_000;
}

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
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { preview: null, customName: null, costUsd: null, contextUsedPercent: null };
  }
  const cacheKey = `${file}:${stat.size}:${stat.mtimeMs}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;

  let raw, fd;
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    raw = buffer.toString('utf8');
  } catch {
    return { preview: null, customName: null, costUsd: null, contextUsedPercent: null };
  }

  const lines = raw.split('\n').filter(Boolean);
  let preview = null;
  let customName = null;
  let costUsd = null;
  let contextUsedPercent = null;
  // Set when a compact_boundary is reached before any later assistant turn
  // claimed contextUsedPercent — holds compactMetadata.postTokens until the
  // next (older) assistant turn's model is found, to size it against that
  // model's window. That turn's own usage is pre-compaction and must NOT
  // also set contextUsedPercent — see the branch below.
  let pendingCompactPostTokens = null;
  // Keeps scanning backward past the first preview/costUsd match, up to
  // the full tail window, so a rename or cost-state further back than the
  // most recent message still gets picked up. costUsd and contextUsedPercent
  // specifically need to be in this exit condition too, not just preview and
  // customName — Claude Code auto-retitles a session periodically (its own
  // "ai-title" entries land right near the end almost every turn, and a
  // cost-state/compact-boundary line even closer), so `preview`+`customName`
  // alone are found almost immediately on real transcripts, which would
  // otherwise stop the scan before it ever reaches back far enough to find
  // the last cost-state line, or the assistant turn needed to size a
  // compact boundary's postTokens (confirmed on real transcripts: both
  // MonitoringAgent and ObsidianAgent had a usable assistant-usage turn only
  // a few lines further back than where the old exit condition stopped).
  for (
    let i = lines.length - 1;
    i >= 0 && !(preview && customName && costUsd !== null && contextUsedPercent !== null);
    i--
  ) {
    let line;
    try {
      line = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Real transcripts never write a `custom-title`/`customTitle` line —
    // that schema was this check's original guess, confirmed wrong
    // 2026-09-14 against real data: Claude Code actually writes
    // `agent-name`/`agentName` (an explicit name) and separately
    // `ai-title`/`aiTitle` (its own auto-generated guess). This is why
    // every dead/renamed session showed "No Name" regardless of whether
    // Claude Code had actually titled it — the lookup matched nothing.
    if (!customName && line.type === 'agent-name' && typeof line.agentName === 'string') {
      const trimmed = line.agentName.trim();
      if (trimmed) customName = trimmed;
    } else if (!customName && line.type === 'ai-title' && typeof line.aiTitle === 'string') {
      const trimmed = line.aiTitle.trim();
      if (trimmed) customName = trimmed;
    }

    if (costUsd === null && line.type === 'cost-state' && typeof line.totalCostUSD === 'number') {
      costUsd = line.totalCostUSD;
    }

    // A manual/auto /compact with no assistant turn after it (the compact
    // was the last thing that happened) leaves no post-compaction usage to
    // read — the newest *real* usage number is compactMetadata.postTokens
    // itself, confirmed present on every real compact_boundary line found
    // (manual and auto triggers alike) across several transcripts. It still
    // needs a model to size that against, which only an assistant turn
    // carries — so remember it and resolve it against the nearest earlier one.
    if (
      contextUsedPercent === null &&
      pendingCompactPostTokens === null &&
      line.type === 'system' &&
      line.subtype === 'compact_boundary' &&
      typeof line.compactMetadata?.postTokens === 'number'
    ) {
      pendingCompactPostTokens = line.compactMetadata.postTokens;
    }

    if (contextUsedPercent === null && line.type === 'assistant' && line.message?.model) {
      if (pendingCompactPostTokens !== null) {
        const windowTokens = contextWindowTokensForModel(line.message.model);
        if (windowTokens) {
          contextUsedPercent = Math.min(100, (pendingCompactPostTokens / windowTokens) * 100);
        }
        // only the nearest turn before the boundary counts, win or lose —
        // an older turn's model has no bearing on tokens counted after it
        pendingCompactPostTokens = null;
      } else if (line.message.usage) {
        const u = line.message.usage;
        const usedTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        const windowTokens = contextWindowTokensForModel(line.message.model);
        // windowTokens is null when this particular turn doesn't carry a
        // recognizable model — skip it rather than fake a percentage; the
        // backward scan keeps looking for an earlier turn that does.
        if (usedTokens > 0 && windowTokens) {
          contextUsedPercent = Math.min(100, (usedTokens / windowTokens) * 100);
        }
      }
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

  if (costUsd === null && start > 0) {
    try {
      costUsd = scanBackwardForCostState(fd, start);
    } catch {
      // leave costUsd null rather than crash the whole session read
    }
  }
  try {
    fs.closeSync(fd);
  } catch {
    // already unusable; nothing left to clean up
  }

  const result = { preview, customName, costUsd, contextUsedPercent };
  previewCache.set(cacheKey, result);
  return result;
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
