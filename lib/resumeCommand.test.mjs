import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeCommand } from './resumeCommand.mjs';

const session = (overrides = {}) => ({
  cwd: 'C:\\work\\proj',
  sessionId: 'abc123',
  id: undefined,
  live: false,
  kind: 'interactive',
  ...overrides,
});

test('default resume template with no {cwd} is unaffected', () => {
  const cmd = buildResumeCommand({
    session: session({ sessionId: 'xyz' }),
    resumeTemplate: 'claude --resume {sessionId}',
    attachTemplate: 'claude attach {id}',
    platform: 'win32',
  });
  assert.equal(cmd, 'claude --resume xyz');
});

test('POSIX: a {cwd} placeholder is single-quoted via shQuote, safe for &, a space and a quote', () => {
  const cmd = buildResumeCommand({
    session: session({ cwd: `/home/a&b 'o said "hi"` }),
    resumeTemplate: 'mytool {cwd}',
    attachTemplate: 'mytool attach {id}',
    platform: 'linux',
  });
  assert.equal(cmd, `mytool '/home/a&b '\\''o said "hi"'`);
});

test('win32: a {cwd} placeholder is double-quoted, with embedded " and % stripped', () => {
  const cmd = buildResumeCommand({
    session: session({ cwd: `C:\\work\\R&D "proj"%x` }),
    resumeTemplate: 'mytool {cwd}',
    attachTemplate: 'mytool attach {id}',
    platform: 'win32',
  });
  assert.equal(cmd, `mytool "C:\\work\\R&D projx"`);
});

test('platform defaults to process.platform when omitted, matching existing callers in server.mjs', () => {
  const expected = process.platform === 'win32' ? '"/plain/path"' : "'/plain/path'";
  const cmd = buildResumeCommand({
    session: session({ cwd: '/plain/path' }),
    resumeTemplate: 'mytool {cwd}',
    attachTemplate: 'mytool attach {id}',
  });
  assert.equal(cmd, `mytool ${expected}`);
});
