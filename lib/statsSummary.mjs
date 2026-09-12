const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 14;

// Four headline numbers for the dashboard's stat cards, plus a sparkline
// series for each. "Sessions tracked" is the only one with anything
// resembling real history: every session's own createdAt is a genuine,
// distinct timestamp, so a daily-count trend over the last two weeks is
// real data, not a guess. Live-now / total-cost / avg-context are
// point-in-time aggregates this app has never persisted a history of —
// there is no historical time-series to plot for them, so their
// sparklines are honestly flat (a single current-value point) rather than
// a fabricated trend line. See app.js's sparklineSvg() for how a
// single-point series renders as a flat line instead of a dot.
export function computeStatsSummary(sessions, now = Date.now()) {
  const sessionsTracked = sessions.length;
  const liveNow = sessions.filter((s) => s.live).length;

  const costs = sessions.map((s) => s.costUsd).filter((v) => typeof v === 'number');
  const totalCostUsd = costs.length ? costs.reduce((sum, v) => sum + v, 0) : null;

  const contextPercents = sessions.map((s) => s.contextUsedPercent).filter((v) => typeof v === 'number');
  const avgContextUsedPercent = contextPercents.length
    ? contextPercents.reduce((sum, v) => sum + v, 0) / contextPercents.length
    : null;

  return {
    sessionsTracked,
    liveNow,
    totalCostUsd,
    avgContextUsedPercent,
    sparklines: {
      sessionsTracked: dailyCreationCounts(sessions, now),
      liveNow: [liveNow],
      totalCostUsd: totalCostUsd == null ? [] : [totalCostUsd],
      avgContextUsedPercent: avgContextUsedPercent == null ? [] : [avgContextUsedPercent],
    },
  };
}

// Real per-day counts of sessions created in the trailing window (oldest
// first, today last) — derived straight from each session's own createdAt,
// nothing synthesized. A session older than the window, or with no
// createdAt at all, is simply not counted in any bucket.
function dailyCreationCounts(sessions, now, windowDays = TREND_WINDOW_DAYS) {
  const counts = new Array(windowDays).fill(0);
  for (const session of sessions) {
    if (typeof session.createdAt !== 'number') continue;
    const ageDays = Math.floor((now - session.createdAt) / DAY_MS);
    if (ageDays >= 0 && ageDays < windowDays) {
      counts[windowDays - 1 - ageDays] += 1;
    }
  }
  return counts;
}
