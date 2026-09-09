function normalizeKind(kind) {
  return kind === 'bg' || kind === 'background' ? 'background' : 'interactive';
}

// liveEntries is null when readLiveAgents() couldn't determine liveness
// (see lib/liveAgents.mjs) — every merged session then gets
// liveUnknown: true and live: false, so callers can distinguish
// "confirmed dead" from "we don't actually know" instead of treating a
// failed liveness check as equivalent to a successful empty one.
export function mergeSessions(registryEntries, liveEntries, getPreview) {
  const liveUnknown = liveEntries === null;
  const entries = liveUnknown ? [] : liveEntries;
  const liveBySessionId = new Map(entries.map((e) => [e.sessionId, e]));

  const merged = registryEntries.map((entry) => {
    const live = liveBySessionId.get(entry.sessionId);
    return {
      name: entry.name,
      sessionId: entry.sessionId,
      id: live?.id ?? entry.jobId ?? null,
      cwd: entry.cwd,
      kind: normalizeKind(live?.kind ?? entry.kind),
      live: liveUnknown ? false : Boolean(live),
      liveUnknown,
      status: live?.status ?? entry.status ?? 'unknown',
      updatedAt: entry.updatedAt ?? entry.startedAt ?? 0,
      preview: getPreview(entry.cwd, entry.sessionId),
    };
  });

  // Live sessions with no registry file yet (freshly started, daemon hasn't
  // written one this run) still show up. Only possible when liveUnknown is
  // false, since entries is [] otherwise.
  for (const live of entries) {
    if (merged.some((m) => m.sessionId === live.sessionId)) continue;
    merged.push({
      name: live.name,
      sessionId: live.sessionId,
      id: live.id ?? null,
      cwd: live.cwd,
      kind: normalizeKind(live.kind),
      live: true,
      liveUnknown: false,
      status: live.status,
      updatedAt: live.startedAt ?? 0,
      preview: getPreview(live.cwd, live.sessionId),
    });
  }

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}
