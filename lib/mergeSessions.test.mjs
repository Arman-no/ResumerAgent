import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessions } from './mergeSessions.mjs';

// Guaranteed not to exist as a real OS pid — used to simulate a stale
// live-agents record (its process has actually exited) without needing to
// spawn and kill a real one.
const DEAD_PID = 999_999_999;
// This test process's own pid — always alive for the duration of the test.
const ALIVE_PID = process.pid;

test('prefers the still-active live-agent record over a finished duplicate for the same sessionId', () => {
  const liveEntries = [
    { sessionId: 'abc', kind: 'background', cwd: 'C:\\x', pid: DEAD_PID },
    { sessionId: 'abc', kind: 'interactive', cwd: 'C:\\x', status: 'busy', pid: ALIVE_PID },
  ];
  const result = mergeSessions([], [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'abc');
  assert.equal(session.kind, 'interactive');
  assert.equal(session.status, 'busy');
});

// Regression, confirmed live 2026-09-13: pausing a real background job via
// `claude stop <id>` doesn't remove it from `claude agents --json --all` —
// it stays listed, alone, its process actually gone (`claude stop`'s own
// contract: the session becomes safely resumable via `claude attach`/
// `--resume`, which would be a double-resume hazard if the original
// process were still alive). Before this fix, mergeSessions treated
// presence of ANY entry as live regardless of its pid, so a session this
// app itself just stopped would still read live: true on the dashboard,
// with Attach offered for a process that no longer exists.
test('a live-agent record whose process has actually exited is never reported as live', () => {
  const transcriptEntries = [{ sessionId: 'xyz', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'xyz', kind: 'background', id: 'xyz1', cwd: 'C:\\x', status: 'idle', pid: DEAD_PID },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'xyz');
  assert.equal(session.live, false);
});

// Regression, confirmed live 2026-09-14 against a real background job
// (PHOENIX-18579) that was genuinely running and mid-conversation with the
// user, yet listed by `claude agents --json --all` with `state: "blocked"`.
// An earlier fix here keyed off that `state` string — first "any state key
// present means historical", then a narrower "done or failed means
// historical" — and both were wrong: `state` turned out to be a
// turn-lifecycle label (confirmed the same job showing "done", "blocked",
// and "working" in quick succession while genuinely alive throughout), not
// a signal the record is stale. The only thing that reliably means "gone"
// is the OS pid actually being gone.
test('a live-agent record with any state string is still live as long as its pid is alive', () => {
  const transcriptEntries = [{ sessionId: 'blocked1', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'blocked1', kind: 'background', id: 'blocked1', cwd: 'C:\\x', status: 'idle', state: 'blocked', pid: ALIVE_PID },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'blocked1');
  assert.equal(session.live, true);
});

// A crashed background job (process exited on its own, no pause involved)
// must be excluded the same way a deliberately-stopped one is — both are
// just "pid no longer alive" to this check, regardless of what state
// string (if any) claude agents happens to report alongside it.
test('a crashed background job (process actually gone) is never reported as live', () => {
  const transcriptEntries = [{ sessionId: 'crashed', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'crashed', kind: 'background', id: 'crashed1', cwd: 'C:\\x', state: 'failed', pid: DEAD_PID },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'crashed');
  assert.equal(session.live, false);
});

// This output `pid` field is sourced from the registry specifically —
// server.mjs's /api/close needs it for a live interactive session, which
// (unlike a background job) has no `id` to act on instead. (Live-agent
// entries do also carry a pid, used internally for the aliveness check
// above, but that's a separate concern from this output field's source.)
test('pid is threaded through from the registry entry, for both a discovered and a brand-new live session', () => {
  const transcriptEntries = [{ sessionId: 'known', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const registryEntries = [
    { sessionId: 'known', name: 'Known', cwd: 'C:\\x', pid: 111 },
    { sessionId: 'brandnew', name: 'New', cwd: 'C:\\y', pid: 222 },
  ];
  const liveEntries = [
    { sessionId: 'known', kind: 'interactive', cwd: 'C:\\x', status: 'busy', pid: ALIVE_PID },
    { sessionId: 'brandnew', kind: 'interactive', cwd: 'C:\\y', status: 'idle', pid: ALIVE_PID },
  ];
  const result = mergeSessions(transcriptEntries, registryEntries, liveEntries, () => ({ preview: null, customName: null }));
  assert.equal(result.find((s) => s.sessionId === 'known').pid, 111);
  assert.equal(result.find((s) => s.sessionId === 'brandnew').pid, 222);
});

// Regression, confirmed live 2026-09-14: an interactive session
// (MonitoringAgent) parked a background job under it and dropped out of
// `claude agents --json --all` entirely as a result, even while genuinely
// alive. parkedJobId (on the interactive session's own registry entry)
// matches the job's own `id` — this is the cross-reference that lets the
// UI show them as a linked pair instead of two unrelated rows.
test('an interactive session that parked a background job under it is linked to that job', () => {
  const transcriptEntries = [
    { sessionId: 'parent1', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 },
    { sessionId: 'child1', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 },
  ];
  const registryEntries = [
    { sessionId: 'parent1', name: 'Parent', cwd: 'C:\\x', parkedJobId: 'job1' },
    { sessionId: 'child1', name: 'Child', cwd: 'C:\\x', jobId: 'job1' },
  ];
  const result = mergeSessions(transcriptEntries, registryEntries, [], () => ({ preview: null, customName: null }));
  const parent = result.find((s) => s.sessionId === 'parent1');
  const child = result.find((s) => s.sessionId === 'child1');
  assert.equal(parent.childSessionId, 'child1');
  assert.equal(child.parentSessionId, 'parent1');
});

test('a parkedJobId with no matching job adds no link and does not crash', () => {
  const transcriptEntries = [{ sessionId: 'lonely1', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const registryEntries = [
    { sessionId: 'lonely1', name: 'Lonely', cwd: 'C:\\x', parkedJobId: 'nonexistent-job' },
  ];
  const result = mergeSessions(transcriptEntries, registryEntries, [], () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'lonely1');
  assert.equal(session.childSessionId, undefined);
});
