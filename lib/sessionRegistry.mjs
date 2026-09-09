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

  const byName = new Map();
  for (const file of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!entry.name || !entry.sessionId || !entry.cwd) continue;

    const existing = byName.get(entry.name);
    if (!existing || (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byName.set(entry.name, entry);
    }
  }

  return [...byName.values()];
}
