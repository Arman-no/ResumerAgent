import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStatsSummary } from './statsSummary.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function session(overrides = {}) {
  return {
    live: false,
    costUsd: null,
    contextUsedPercent: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

test('empty session list reports zeros/nulls, not crashes', () => {
  const stats = computeStatsSummary([]);
  assert.equal(stats.sessionsTracked, 0);
  assert.equal(stats.liveNow, 0);
  assert.equal(stats.totalCostUsd, null);
  assert.equal(stats.avgContextUsedPercent, null);
  assert.deepEqual(stats.sparklines.liveNow, [0]);
  assert.deepEqual(stats.sparklines.totalCostUsd, []);
  assert.deepEqual(stats.sparklines.avgContextUsedPercent, []);
});

test('total cost sums only sessions with real cost data', () => {
  const stats = computeStatsSummary([
    session({ costUsd: 1.5 }),
    session({ costUsd: null }),
    session({ costUsd: 2.25 }),
  ]);
  assert.equal(stats.totalCostUsd, 3.75);
  assert.deepEqual(stats.sparklines.totalCostUsd, [3.75]);
});

test('avg context used averages only sessions with real context data', () => {
  const stats = computeStatsSummary([
    session({ contextUsedPercent: 20 }),
    session({ contextUsedPercent: null }),
    session({ contextUsedPercent: 40 }),
  ]);
  assert.equal(stats.avgContextUsedPercent, 30);
});

test('live now counts only sessions currently live', () => {
  const stats = computeStatsSummary([
    session({ live: true }),
    session({ live: false }),
    session({ live: true }),
  ]);
  assert.equal(stats.liveNow, 2);
  assert.deepEqual(stats.sparklines.liveNow, [2]);
});

test('sessions-tracked sparkline buckets real createdAt into daily counts, oldest first', () => {
  const now = Date.now();
  const stats = computeStatsSummary([
    session({ createdAt: now }),               // today
    session({ createdAt: now - 1 * DAY_MS }),  // yesterday
    session({ createdAt: now - 1 * DAY_MS }),  // yesterday (2nd)
    session({ createdAt: now - 13 * DAY_MS }), // 13 days ago (oldest in window)
    session({ createdAt: now - 30 * DAY_MS }), // outside the 14-day window entirely
  ], now);
  const trend = stats.sparklines.sessionsTracked;
  assert.equal(trend.length, 14);
  assert.equal(trend[13], 1); // today
  assert.equal(trend[12], 2); // yesterday
  assert.equal(trend[0], 1);  // 13 days ago, oldest bucket
  assert.equal(trend.reduce((a, b) => a + b, 0), 4); // the 30-day-old session isn't in any bucket
});

test('sessions tracked counts every session regardless of cost/context/live data', () => {
  const stats = computeStatsSummary([session(), session(), session()]);
  assert.equal(stats.sessionsTracked, 3);
});
