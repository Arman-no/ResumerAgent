import fs from 'node:fs';
import path from 'node:path';

// Most first lines observed on this machine are ~100-125 bytes, but a real
// background-agent transcript (PHOENIX-18579, confirmed 2026-09-14) opens
// with several KB of ai-title/agent-name/mode/file-history-snapshot lines
// before the first cwd-bearing one — that session's cwd landed at ~18KB,
// well past the old 8KB cutoff, and was silently dropped from discovery
// entirely. Widened with real margin over that observed case — but it's
// still a hard cutoff: if cwd ever appears past this many bytes into a
// file, that session is silently dropped rather than degrading to a
// slower full-file scan.
const MAX_HEAD_BYTES = 65_536;

// cwd and gitBranch are present on essentially every line of a transcript,
// so a small prefix read is enough — no need for the tail-read that
// transcriptPreview.mjs does to find the last message.
function readHeadFields(file) {
  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_HEAD_BYTES, 0);
    fs.closeSync(fd);
    raw = buffer.toString('utf8', 0, bytesRead);
  } catch {
    return {};
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.cwd) {
      return { cwd: parsed.cwd, gitBranch: parsed.gitBranch ?? null };
    }
  }
  return {};
}

// Discovers every session transcript under <sessionsRoot>/projects/,
// regardless of whether its sessions/*.json registry pointer still exists.
// Claude Code deletes that pointer on a clean exit (closing a terminal
// normally, typing exit) — the transcript itself survives that. This is
// why the registry alone missed exactly the sessions this tool exists to
// recover; scanning transcripts directly is the primary discovery
// mechanism now, not a fallback.
export function discoverSessions(sessionsRoot, maxAgeMs) {
  const projectsDir = path.join(sessionsRoot, 'projects');
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const cutoff = Date.now() - maxAgeMs;
  const sessions = [];

  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;

      const sessionId = file.slice(0, -'.jsonl'.length);
      const { cwd, gitBranch } = readHeadFields(filePath);
      if (!cwd) continue;

      sessions.push({
        sessionId,
        cwd,
        gitBranch,
        sizeBytes: stat.size,
        updatedAt: stat.mtimeMs,
        // NTFS tracks true creation time (unlike ext4, where birthtime is
        // often unavailable) — safe to rely on for the "created" sort,
        // since this tool is Windows-only.
        createdAt: stat.birthtimeMs,
        // The real path this session was actually found at — callers that
        // need to read more of the file (transcriptPreview.mjs's preview
        // extraction) should use this directly rather than re-deriving it
        // through encodeCwdForProjectDir's best-effort, potentially-lossy
        // guess a second time for no reason.
        filePath,
      });
    }
  }

  return sessions;
}
