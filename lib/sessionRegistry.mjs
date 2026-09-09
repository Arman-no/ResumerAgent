import fs from 'node:fs';
import path from 'node:path';

export function readSessionRegistry(sessionsRoot) {
  const dir = path.join(sessionsRoot, 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Deduped by sessionId, not by name. A session resumed multiple times
  // can leave several pointer files behind (one per PID it ever ran
  // under) that all share the same sessionId — collapsing those to the
  // most recently updated one is the actual point of dedup here. Deduping
  // by name instead was a real bug: two independently-running sessions
  // that both happen to carry the same user-given name (confirmed on this
  // machine — two live sessions both named "MotherAgent", different
  // sessionIds) silently lost one entry's name, pid, and everything else
  // to the other, which broke both the "No Name" fallback and a liveness
  // safety check that depends on every registry entry's own pid being
  // reachable by its own sessionId.
  const bySessionId = new Map();
  for (const file of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!entry.name || !entry.sessionId || !entry.cwd) continue;

    const existing = bySessionId.get(entry.sessionId);
    if (!existing || (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      bySessionId.set(entry.sessionId, entry);
    }
  }

  return [...bySessionId.values()];
}
