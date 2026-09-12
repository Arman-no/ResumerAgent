import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDaysUntilExpiry } from './expiry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

test('cleanupPeriodDays 0 means never expires', () => {
  assert.equal(computeDaysUntilExpiry(Date.now() - 999 * DAY_MS, 0), null);
});

test('a fresh session has close to the full period left', () => {
  const now = Date.now();
  const result = computeDaysUntilExpiry(now, 30, now);
  assert.equal(result, 30);
});

test('a session past its cleanup cutoff comes back negative, not clamped', () => {
  const now = Date.now();
  const updatedAt = now - 35 * DAY_MS;
  const result = computeDaysUntilExpiry(updatedAt, 30, now);
  assert.equal(result, -5);
});
