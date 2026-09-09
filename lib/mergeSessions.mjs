function normalizeKind(kind) {
  return kind === 'bg' || kind === 'background' ? 'background' : 'interactive';
}

// A session discovered straight from its transcript has no saved display
// name. It's tempting to fall back to the preview (the last real typed
// message) as a stand-in name, but that duplicates information the row
// already shows on its own preview line — showing literally "No Name"
// instead makes it obvious at a glance which sessions Claude Code never
// got a name for, while the preview line right below still carries the
// actual context to identify the session by.
const NO_NAME = 'No Name';

// `claude agents --json --all` is not exhaustive. Confirmed via a real
// incident: a session forked into a new session (`--fork-session
// --resume <transcript>`) keeps its original process running, but that
// original process never appeared in `claude agents --json --all` at
// all — not stale, not misreported, just absent. The dashboard showed it
// as a plain resumable session, and clicking Resume spawned a second
// `claude --resume` against a transcript whose original process was
// still very much alive, which surfaced as that live session's own
// terminal content appearing in the new window. `claude agents` cannot be
// the only source of truth for liveness after that. This is the
// independent second check: the registry pointer file (sessions/*.json)
// records the PID that wrote it, and that's something we can verify
// directly against the OS process table ourselves, with no dependency on
// `claude agents`'s own completeness.
function isPidAlive(pid) {
  if (typeof pid !== 'number') return false;
  try {
    // Signal 0 sends nothing — it only asks the OS "does this PID exist
    // and can I signal it", which Node implements on Windows too (via
    // OpenProcess internally) despite Windows having no real POSIX
    // signals. Throws ESRCH-equivalent if the PID is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// transcriptEntries (lib/discoverSessions.mjs) is the primary source of
// dead/resumable sessions — it's what survives a clean exit, which the
// sessions/*.json registry does not. registryEntries only overlays a
// nicer name when Claude Code happened to record one; liveEntries overlays
// live status exactly as before. liveEntries is null when readLiveAgents()
// couldn't determine liveness — every merged session then gets
// liveUnknown: true and live: false, so callers can distinguish
// "confirmed dead" from "we don't actually know" instead of treating a
// failed liveness check as equivalent to a successful empty one.
export function mergeSessions(transcriptEntries, registryEntries, liveEntries, getPreview) {
  const liveUnknown = liveEntries === null;
  const live = liveUnknown ? [] : liveEntries;
  const liveBySessionId = new Map(live.map((e) => [e.sessionId, e]));
  const registryBySessionId = new Map(registryEntries.map((e) => [e.sessionId, e]));

  const merged = transcriptEntries.map((entry) => {
    const liveEntry = liveBySessionId.get(entry.sessionId);
    const registryEntry = registryBySessionId.get(entry.sessionId);
    // entry.filePath is the real path discoverSessions.mjs already found
    // this session at — pass the whole entry through so the caller can use
    // that directly instead of re-deriving the path via cwd encoding.
    // customName comes from the transcript itself (a `/rename`), not the
    // registry — it's what lets a renamed session keep its name after a
    // clean exit deletes the registry pointer, which registryEntry?.name
    // alone cannot survive.
    const { preview, customName } = getPreview(entry);
    // Only relevant when claude agents didn't already call this session
    // live — if it did, `live: true` already governs it. This is strictly
    // an extra fail-closed check for the gap claude agents can leave: a
    // session whose registry pid is still a real running process, that
    // claude agents nonetheless omitted entirely.
    const registryPidStillAlive = !liveUnknown && !liveEntry && isPidAlive(registryEntry?.pid);

    return {
      name: registryEntry?.name ?? customName ?? NO_NAME,
      sessionId: entry.sessionId,
      id: liveEntry?.id ?? registryEntry?.jobId ?? null,
      cwd: entry.cwd,
      gitBranch: entry.gitBranch,
      sizeBytes: entry.sizeBytes,
      kind: normalizeKind(liveEntry?.kind ?? registryEntry?.kind),
      live: liveUnknown ? false : Boolean(liveEntry),
      liveUnknown: liveUnknown || registryPidStillAlive,
      status: liveEntry?.status ?? registryEntry?.status ?? 'unknown',
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
      preview,
      // Carried through so a mutating consumer (lib/purgeSession.mjs) can
      // locate this session's real file directly, the same reason
      // getPreview above takes the whole entry instead of re-deriving the
      // path via cwd encoding — that encoding is a documented best-effort
      // guess, fine for a missing preview, not fine for a move that
      // should either happen or visibly fail.
      filePath: entry.filePath,
    };
  });

  // A brand-new live session whose transcript hasn't been flushed to disk
  // yet (or is older than the discovery window) still shows up. Only
  // possible when liveUnknown is false, since live is [] otherwise.
  for (const liveEntry of live) {
    if (merged.some((m) => m.sessionId === liveEntry.sessionId)) continue;
    const registryEntry = registryBySessionId.get(liveEntry.sessionId);
    const { preview: livePreview, customName: liveCustomName } = getPreview({
      cwd: liveEntry.cwd,
      sessionId: liveEntry.sessionId,
    });
    merged.push({
      name: liveEntry.name ?? registryEntry?.name ?? liveCustomName ?? NO_NAME,
      sessionId: liveEntry.sessionId,
      id: liveEntry.id ?? null,
      cwd: liveEntry.cwd,
      gitBranch: null,
      sizeBytes: null,
      kind: normalizeKind(liveEntry.kind),
      live: true,
      liveUnknown: false,
      status: liveEntry.status,
      // A live session with no known start time is more sensibly sorted
      // as recent than as the oldest possible entry (the prior `?? 0`
      // would sink it to the bottom of the list instead).
      updatedAt: liveEntry.startedAt ?? Date.now(),
      createdAt: liveEntry.startedAt ?? Date.now(),
      // No filePath here — this session's transcript hasn't been
      // discovered (too new to be flushed to disk yet, or older than the
      // discovery window), so callers fall back to the cwd/sessionId
      // encoding-based lookup for this one entry. Not reachable from
      // lib/purgeSession.mjs in practice: this branch always has
      // live: true, and purging refuses any live session outright.
      preview: livePreview,
      filePath: null,
    });
  }

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}
