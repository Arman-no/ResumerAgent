function normalizeKind(kind) {
  return kind === 'bg' || kind === 'background' ? 'background' : 'interactive';
}

export function mergeSessions(registryEntries, liveEntries, getPreview) {
  const liveBySessionId = new Map(liveEntries.map((e) => [e.sessionId, e]));

  const merged = registryEntries.map((entry) => {
    const live = liveBySessionId.get(entry.sessionId);
    return {
      name: entry.name,
      sessionId: entry.sessionId,
      id: live?.id ?? entry.jobId ?? null,
      cwd: entry.cwd,
      kind: normalizeKind(live?.kind ?? entry.kind),
      live: Boolean(live),
      status: live?.status ?? entry.status ?? 'unknown',
      updatedAt: entry.updatedAt ?? entry.startedAt ?? 0,
      preview: getPreview(entry.cwd, entry.sessionId),
    };
  });

  // Live sessions with no registry file yet (freshly started, daemon hasn't
  // written one this run) still show up.
  for (const live of liveEntries) {
    if (merged.some((m) => m.sessionId === live.sessionId)) continue;
    merged.push({
      name: live.name,
      sessionId: live.sessionId,
      id: live.id ?? null,
      cwd: live.cwd,
      kind: normalizeKind(live.kind),
      live: true,
      status: live.status,
      updatedAt: live.startedAt ?? 0,
      preview: getPreview(live.cwd, live.sessionId),
    });
  }

  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}
