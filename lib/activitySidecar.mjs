import fs from 'node:fs';
import path from 'node:path';

// Written by this user's own statusline script (~/.claude/statusline.ps1),
// overwritten on every statusline refresh — freshness is bounded by how
// recently that session was actually active in a terminal with this
// statusline configured, not polled or requested by this tool. Absent for
// any session without a statusline wired up to write it (the common case
// for anyone else running ResumerAgent, or before this session's first
// refresh) — that's not an error, just no sidecar data for that session
// yet, and callers should degrade gracefully rather than treat it as one.
//
// Verified live shape — every field except session_id/model/cwd/updated_at
// may be `null` (never `{}`) when Claude Code hasn't computed it yet:
//   { session_id, session_name, model, cwd, git_branch, updated_at,
//     context_window: { used_percentage, context_window_size } | null,
//     rate_limits: {
//       five_hour: { used_percentage, resets_at } | null,
//       seven_day: { used_percentage, resets_at } | null,
//     } | null,
//     cost: { total_cost_usd, total_duration_ms } | null }
// Matched by filename (sessionId.json), not by reading every file in the
// directory and comparing the session_id field inside — the filename
// already is the match key, so there's nothing to scan.
const BOM = '﻿';

export function readActivitySidecar(sessionsRoot, sessionId) {
  try {
    const raw = fs.readFileSync(path.join(sessionsRoot, 'activity', `${sessionId}.json`), 'utf8');
    // PowerShell's Out-File/Set-Content (what a statusline.ps1 writer would
    // naturally reach for) defaults to UTF-8 *with* a BOM — confirmed
    // against the real file this reads on this machine. JSON.parse treats
    // a leading U+FEFF as a syntax error, not whitespace, so it has to be
    // stripped explicitly; Node's fs does not do this for you.
    const cleaned = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
