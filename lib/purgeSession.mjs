import fs from 'node:fs';
import path from 'node:path';
import { encodeCwdForProjectDir } from './pathEncoding.mjs';

// Moves a session's transcript (and its companion directory, if Claude
// Code created one alongside the .jsonl) out of projects/ and into a
// trash folder under SESSIONS_ROOT — never a real delete. This is
// deliberately reversible: move the folder back to undo it, or empty
// .resumeragent-trash yourself when you're sure. The caller (server.mjs)
// is responsible for refusing to call this for any session that is live
// or whose liveness couldn't be confirmed, and for treating an empty
// `moved` array as a failure rather than a silent no-op success — this
// function itself doesn't throw on that case, since finding nothing to
// move at a given path isn't a filesystem error.
//
// Unlike the read-only lib/ modules (sessionRegistry.mjs,
// discoverSessions.mjs), this one does not swallow fs errors into a safe
// default — a failed mutation must be loud, not silently treated as "no
// session found."
export function purgeSessionFiles(sessionsRoot, session) {
  // session.filePath (set by discoverSessions.mjs, threaded through
  // mergeSessions.mjs) is the real path this session was found at —
  // prefer it over re-deriving the directory via encodeCwdForProjectDir's
  // best-effort, potentially-lossy guess, which is fine for a missing
  // preview but not for a move that must either happen or visibly fail.
  // Only a live session lacks filePath, and purging always refuses those
  // before calling this function, so the encoding fallback below is
  // defensive, not the expected path.
  const encodedDir = encodeCwdForProjectDir(session.cwd);
  const projectDir = session.filePath
    ? path.dirname(session.filePath)
    : path.join(sessionsRoot, 'projects', encodedDir);
  const trashDir = path.join(sessionsRoot, '.resumeragent-trash', encodedDir);

  fs.mkdirSync(trashDir, { recursive: true });

  const candidates = [`${session.sessionId}.jsonl`, session.sessionId]
    .filter((name) => fs.existsSync(path.join(projectDir, name)));

  // renameSync would silently overwrite an earlier trashed copy.
  const clash = candidates.find((name) => fs.existsSync(path.join(trashDir, name)));
  if (clash) throw new Error(`Trash already contains ${clash}; empty it first`);

  // All-or-nothing: if the companion dir can't move (open handle, EBUSY),
  // put the already-moved transcript back instead of leaving it half-purged.
  const moved = [];
  try {
    for (const name of candidates) {
      fs.renameSync(path.join(projectDir, name), path.join(trashDir, name));
      moved.push(name);
    }
  } catch (err) {
    for (const name of moved.reverse()) {
      fs.renameSync(path.join(trashDir, name), path.join(projectDir, name));
    }
    throw err;
  }

  return { movedTo: trashDir, moved };
}
