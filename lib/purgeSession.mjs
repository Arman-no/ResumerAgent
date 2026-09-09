import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

// Moves a session's transcript (and its companion directory, if Claude
// Code created one alongside the .jsonl) out of projects/ and into a
// trash folder under SESSIONS_ROOT — never a real delete. This is
// deliberately reversible: move the folder back to undo it, or empty
// .resumeragent-trash yourself when you're sure. The caller (server.mjs)
// is responsible for refusing to call this for any session that is live
// or whose liveness couldn't be confirmed.
export function purgeSessionFiles(sessionsRoot, session) {
  const encodedDir = encodeCwdForProjectDir(session.cwd);
  const projectDir = path.join(sessionsRoot, 'projects', encodedDir);
  const trashDir = path.join(sessionsRoot, '.resumeragent-trash', encodedDir);

  fs.mkdirSync(trashDir, { recursive: true });

  const moved = [];
  const candidates = [`${session.sessionId}.jsonl`, session.sessionId];

  for (const name of candidates) {
    const src = path.join(projectDir, name);
    const dest = path.join(trashDir, name);
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, dest);
    moved.push(name);
  }

  return { movedTo: trashDir, moved };
}
