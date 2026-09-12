const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors Claude Code's own cleanup math (see docs/2026-09-12-expiry-warning-design.md):
// it deletes a transcript whose mtime is older than `now - cleanupPeriodDays` days.
// cleanupPeriodDays === 0 means cleanup is disabled — null return means "never
// expires", distinct from 0 days left (which would read as "expiring today").
export function computeDaysUntilExpiry(updatedAt, cleanupPeriodDays, now = Date.now()) {
  if (!cleanupPeriodDays) return null;
  return cleanupPeriodDays - (now - updatedAt) / DAY_MS;
}
