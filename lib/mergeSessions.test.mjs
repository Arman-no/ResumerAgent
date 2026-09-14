import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessions } from './mergeSessions.mjs';

test('prefers the still-active live-agent record over a finished duplicate for the same sessionId', () => {
  const liveEntries = [
    { sessionId: 'abc', kind: 'background', cwd: 'C:\\x', state: 'done' },
    { sessionId: 'abc', kind: 'interactive', cwd: 'C:\\x', status: 'busy' },
  ];
  const result = mergeSessions([], [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'abc');
  assert.equal(session.kind, 'interactive');
  assert.equal(session.status, 'busy');
});

// Regression, confirmed live 2026-09-13: pausing a real background job via
// `claude stop <id>` doesn't remove it from `claude agents --json --all` —
// it stays listed, alone, with state flipped to "done". Before this fix,
// mergeSessions treated presence of ANY entry (done or not) as live, so a
// session this app itself just stopped would still read live: true on the
// dashboard, with Attach offered for a process that no longer exists.
test('a lone done background-job record is never reported as live', () => {
  const transcriptEntries = [{ sessionId: 'xyz', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'xyz', kind: 'background', id: 'xyz1', cwd: 'C:\\x', status: 'idle', state: 'done' },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'xyz');
  assert.equal(session.live, false);
});

// Found on a real machine while verifying the fix above: a crashed
// background job (no pause involved) shows up the same way, with
// state: "failed" instead of "done" and no `status` key at all — the fix
// checks for the *presence* of a state key rather than one known value,
// specifically to cover cases like this one that weren't the original
// trigger.
// Regression, confirmed live 2026-09-14 against a real background job
// (PHOENIX-18579) that was genuinely running and mid-conversation with the
// user, yet listed by `claude agents --json --all` with `state: "blocked"`.
// Before this fix, the state-key-presence check treated this identically
// to a terminal "done"/"failed" record, so a truly live agent vanished
// from the dashboard entirely.
test('a blocked (but not done/failed) background job is still reported as live', () => {
  const transcriptEntries = [{ sessionId: 'blocked1', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'blocked1', kind: 'background', id: 'blocked1', cwd: 'C:\\x', status: 'idle', state: 'blocked' },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'blocked1');
  assert.equal(session.live, true);
});

test('a lone failed background-job record is never reported as live', () => {
  const transcriptEntries = [{ sessionId: 'crashed', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'crashed', kind: 'background', id: 'crashed1', cwd: 'C:\\x', state: 'failed' },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'crashed');
  assert.equal(session.live, false);
});

// `pid` has no other source but the registry — `claude agents` itself
// never reports one (confirmed against real output). server.mjs's
// /api/close needs it for a live interactive session, which (unlike a
// background job) has no `id` to act on instead.
test('pid is threaded through from the registry entry, for both a discovered and a brand-new live session', () => {
  const transcriptEntries = [{ sessionId: 'known', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const registryEntries = [
    { sessionId: 'known', name: 'Known', cwd: 'C:\\x', pid: 111 },
    { sessionId: 'brandnew', name: 'New', cwd: 'C:\\y', pid: 222 },
  ];
  const liveEntries = [
    { sessionId: 'known', kind: 'interactive', cwd: 'C:\\x', status: 'busy' },
    { sessionId: 'brandnew', kind: 'interactive', cwd: 'C:\\y', status: 'idle' },
  ];
  const result = mergeSessions(transcriptEntries, registryEntries, liveEntries, () => ({ preview: null, customName: null }));
  assert.equal(result.find((s) => s.sessionId === 'known').pid, 111);
  assert.equal(result.find((s) => s.sessionId === 'brandnew').pid, 222);
});
