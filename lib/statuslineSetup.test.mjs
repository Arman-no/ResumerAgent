import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConfigDir,
  buildCommand,
  encodeChain,
  decodeChain,
  extractChain,
  classifyStatusLine,
  isSidecarStatuslineConfigured,
  computeInstalledSettings,
  computeRemovedSettings,
} from './statuslineSetup.mjs';

test('resolveConfigDir prefers CLAUDE_CONFIG_DIR, else falls back to ~/.claude', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '/custom/dir' }), '/custom/dir');
  const fallback = resolveConfigDir({});
  assert.ok(fallback.endsWith('.claude'));
});

test('buildCommand double-quotes both paths and normalizes backslashes', () => {
  const command = buildCommand({ scriptPath: 'C:\\Users\\John Doe\\repo\\scripts\\statusline-sidecar.mjs', execPath: 'C:\\Program Files\\nodejs\\node.exe' });
  assert.equal(command, '"C:\\Program Files\\nodejs\\node.exe" "C:/Users/John Doe/repo/scripts/statusline-sidecar.mjs"');
});

test('buildCommand appends a base64 --chain when wrapping an original command', () => {
  const command = buildCommand({ scriptPath: '/abs/statusline-sidecar.mjs', execPath: '/usr/bin/node', chainCommand: 'my-old-statusline.sh' });
  assert.match(command, /^"\/usr\/bin\/node" "\/abs\/statusline-sidecar\.mjs" --chain [A-Za-z0-9+/=]+$/);
  const encoded = command.split('--chain ')[1];
  assert.equal(decodeChain(encoded), 'my-old-statusline.sh');
});

test('encodeChain/decodeChain round-trip, including shell metacharacters', () => {
  const tricky = `echo "hi" && node foo.js | grep 'bar' $HOME \`whoami\``;
  assert.equal(decodeChain(encodeChain(tricky)), tricky);
});

test('extractChain pulls the original command back out of a chained statusline command', () => {
  const command = buildCommand({ scriptPath: '/abs/statusline-sidecar.mjs', chainCommand: 'original --flag' });
  assert.equal(extractChain(command), 'original --flag');
});

test('extractChain returns null when there is no --chain', () => {
  assert.equal(extractChain('"node" "/abs/statusline-sidecar.mjs"'), null);
});

test('classifyStatusLine: no statusLine at all', () => {
  assert.deepEqual(classifyStatusLine({}), { kind: 'none' });
  assert.deepEqual(classifyStatusLine({ statusLine: null }), { kind: 'none' });
});

test('classifyStatusLine: an existing foreign command statusLine', () => {
  const settings = { statusLine: { type: 'command', command: 'my-old-statusline.sh' } };
  assert.deepEqual(classifyStatusLine(settings), { kind: 'other-command', command: 'my-old-statusline.sh' });
});

test('classifyStatusLine: already ours (plain or chained)', () => {
  const plain = { statusLine: { type: 'command', command: '"node" "/x/statusline-sidecar.mjs"' } };
  assert.equal(classifyStatusLine(plain).kind, 'ours');

  const chained = { statusLine: { type: 'command', command: '"node" "/x/statusline-sidecar.mjs" --chain Zm9v' } };
  assert.equal(classifyStatusLine(chained).kind, 'ours');
});

test('classifyStatusLine: another type/shape entirely is left alone', () => {
  assert.equal(classifyStatusLine({ statusLine: 'legacy-string-form' }).kind, 'other-shape');
  assert.equal(classifyStatusLine({ statusLine: { type: 'module', path: 'x.mjs' } }).kind, 'other-shape');
});

test('isSidecarStatuslineConfigured mirrors classifyStatusLine', () => {
  assert.equal(isSidecarStatuslineConfigured({}), false);
  assert.equal(isSidecarStatuslineConfigured({ statusLine: { type: 'command', command: '/x/statusline-sidecar.mjs' } }), true);
});

test('computeInstalledSettings sets statusLine and preserves every other key', () => {
  const before = { someOtherKey: 'untouched', nested: { a: 1 } };
  const after = computeInstalledSettings(before, 'the-command');
  assert.deepEqual(after, {
    someOtherKey: 'untouched',
    nested: { a: 1 },
    statusLine: { type: 'command', command: 'the-command' },
  });
});

test('computeRemovedSettings: no-chain install -> remove deletes the key, nothing else lost', () => {
  const command = buildCommand({ scriptPath: '/x/statusline-sidecar.mjs' });
  const installed = computeInstalledSettings({ otherKey: 'kept' }, command);
  const removed = computeRemovedSettings(installed);
  assert.deepEqual(removed, { otherKey: 'kept' });
});

test('computeRemovedSettings: chained install -> remove restores the exact original command', () => {
  const original = 'my-old-statusline.sh --fancy "quoted arg"';
  const command = buildCommand({ scriptPath: '/x/statusline-sidecar.mjs', chainCommand: original });
  const installed = computeInstalledSettings({ otherKey: 'kept' }, command);
  const removed = computeRemovedSettings(installed);
  assert.deepEqual(removed, { otherKey: 'kept', statusLine: { type: 'command', command: original } });
});

test('computeRemovedSettings returns null when the statusLine is not ours', () => {
  assert.equal(computeRemovedSettings({ statusLine: { type: 'command', command: 'someone-elses.sh' } }), null);
  assert.equal(computeRemovedSettings({}), null);
});
