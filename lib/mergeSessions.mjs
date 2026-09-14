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
  // `claude agents --json --all` can list the same sessionId twice: a
  // finished/failed background-job record alongside the session's own
  // fresh interactive attach. It also keeps listing a background job on
  // its own, with no live companion entry at all, once it's no longer
  // actually running.
  //
  // Two earlier attempts tried to infer that from the `state` field —
  // first "any state key present means historical", then a narrower
  // "state is done or failed means historical" — and both were wrong.
  // Confirmed 2026-09-14: an actively running, mid-chat background job
  // (PHOENIX-18579) was listed with `state: "blocked"`, and — in the very
  // same poll, for *this ResumerAgent session itself* — the exact same
  // job showed `state: "done"` moments earlier and `state: "working"`
  // moments later, purely reflecting its current turn, not whether the
  // record is stale. `state` is a turn-lifecycle label for a session
  // that's still running, not a signal that it's gone. There is no known
  // string value that reliably means "this record is historical."
  //
  // The one thing that *is* ground truth: every entry here carries the
  // real OS pid that's serving it (confirmed live 2026-09-14 against real
  // output — always present, background or interactive). If that pid is
  // gone, the record is stale, full stop — no need to guess at Claude
  // Code's own vocabulary for describing it. Reuses the exact same check
  // already relied on below for the registry-pid fallback.
  const liveBySessionId = new Map();
  for (const e of live) {
    if (!isPidAlive(e.pid)) continue;
    if (!liveBySessionId.has(e.sessionId)) liveBySessionId.set(e.sessionId, e);
  }
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
    const { preview, customName, costUsd, contextUsedPercent } = getPreview(entry);
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
      // Only the registry ever carries a real OS pid — `claude agents`
      // itself doesn't report one. Exposed (previously computed only for
      // the internal isPidAlive() check below) so server.mjs's /api/close
      // has something to act on for a live interactive session, which has
      // no `id` the way a background job does.
      pid: registryEntry?.pid ?? null,
      cwd: entry.cwd,
      gitBranch: entry.gitBranch,
      sizeBytes: entry.sizeBytes,
      kind: normalizeKind(liveEntry?.kind ?? registryEntry?.kind),
      live: liveUnknown ? false : Boolean(liveEntry),
      liveUnknown: liveUnknown || registryPidStillAlive,
      // Distinguishes "we have no liveness data at all" (readLiveAgents
      // itself failed) from "we know for a fact this is still running,
      // claude agents just didn't report it" — the two are not the same
      // level of uncertainty, and showing them with the same "status
      // unknown" text buries a case we're actually confident about behind
      // language that says we aren't.
      pidConfirmedAlive: registryPidStillAlive,
      // Overwritten to true by markSupersededByName() below when another
      // session shares this one's name and is the more current of the two.
      superseded: false,
      status: liveEntry?.status ?? registryEntry?.status ?? 'unknown',
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
      preview,
      costUsd,
      contextUsedPercent,
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
  for (const liveEntry of liveBySessionId.values()) {
    if (merged.some((m) => m.sessionId === liveEntry.sessionId)) continue;
    const registryEntry = registryBySessionId.get(liveEntry.sessionId);
    const {
      preview: livePreview,
      customName: liveCustomName,
      costUsd: liveCostUsd,
      contextUsedPercent: liveContextUsedPercent,
    } = getPreview({
      cwd: liveEntry.cwd,
      sessionId: liveEntry.sessionId,
    });
    merged.push({
      name: liveEntry.name ?? registryEntry?.name ?? liveCustomName ?? NO_NAME,
      sessionId: liveEntry.sessionId,
      id: liveEntry.id ?? null,
      pid: registryEntry?.pid ?? null,
      cwd: liveEntry.cwd,
      gitBranch: null,
      sizeBytes: null,
      kind: normalizeKind(liveEntry.kind),
      live: true,
      liveUnknown: false,
      pidConfirmedAlive: false,
      superseded: false,
      status: liveEntry.status ?? registryEntry?.status ?? 'unknown',
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
      costUsd: liveCostUsd,
      contextUsedPercent: liveContextUsedPercent,
      filePath: null,
    });
  }

  markSupersededByName(merged);

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

// A real workflow: a session's transcript grows huge over a long life,
// hurting performance (every poll re-reads its tail for a preview), so the
// user closes it and starts a fresh session, renaming the new one to the
// same name the old one had. Both are still discoverable — the old one's
// transcript doesn't go anywhere on its own — so without this, the same
// name would appear to just duplicate itself in the list, and the huge
// retired transcript would keep costing the same read-its-tail-every-poll
// work as a session actually still in use. Groups sessions by name (real
// names only — grouping by "No Name" would incorrectly link every unnamed
// session together) and marks every non-live, non-liveUnknown member of a
// group *except* the most recently updated one as superseded. A live or
// liveUnknown session is never marked superseded even if outranked by
// updatedAt — it's still doing something on its own, not "replaced."
function markSupersededByName(sessions) {
  const byName = new Map();
  for (const session of sessions) {
    if (session.name === NO_NAME) continue;
    const group = byName.get(session.name);
    if (group) group.push(session);
    else byName.set(session.name, [session]);
  }

  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const current = group.reduce((best, s) => {
      if (s.live && !best.live) return s;
      if (best.live && !s.live) return best;
      return s.updatedAt > best.updatedAt ? s : best;
    });
    for (const s of group) {
      if (s !== current && !s.live && !s.liveUnknown) {
        s.superseded = true;
      }
    }
  }
}
