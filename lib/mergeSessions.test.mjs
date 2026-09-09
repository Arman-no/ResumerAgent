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
