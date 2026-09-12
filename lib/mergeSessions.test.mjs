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
test('a lone failed background-job record is never reported as live', () => {
  const transcriptEntries = [{ sessionId: 'crashed', cwd: 'C:\\x', updatedAt: 1, createdAt: 1 }];
  const liveEntries = [
    { sessionId: 'crashed', kind: 'background', id: 'crashed1', cwd: 'C:\\x', state: 'failed' },
  ];
  const result = mergeSessions(transcriptEntries, [], liveEntries, () => ({ preview: null, customName: null }));
  const session = result.find((s) => s.sessionId === 'crashed');
  assert.equal(session.live, false);
});
