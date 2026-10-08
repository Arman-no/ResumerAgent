import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseNetstatPid,
  parseLsofPids,
  isOurServer,
  waitUntil,
} from './launch.mjs';

// Real-looking netstat -ano output — English (LISTENING) and German
// (ABHÖREN) — both with an unrelated ESTABLISHED row that happens to share
// the target port in its local-address column, to prove detection keys off
// the foreign-address shape (0.0.0.0:0 / [::]:0) and not the STATE text.

const englishNetstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2040
  TCP    0.0.0.0:4317           0.0.0.0:0              LISTENING       9999
  TCP    127.0.0.1:4317         127.0.0.1:50563        ESTABLISHED     7100
  TCP    [::]:4317              [::]:0                 LISTENING       9999
`;

const germanNetstat = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status          PID
  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN         2040
  TCP    0.0.0.0:4317           0.0.0.0:0              ABHÖREN         9999
  TCP    127.0.0.1:4317         127.0.0.1:50563         HERGESTELLT    7100
  TCP    [::]:4317              [::]:0                 ABHÖREN         9999
`;

test('parseNetstatPid finds the listening pid in English netstat output', () => {
  assert.equal(parseNetstatPid(englishNetstat, 4317), '9999');
});

test('parseNetstatPid finds the listening pid in German netstat output (ABHÖREN, not LISTENING)', () => {
  assert.equal(parseNetstatPid(germanNetstat, 4317), '9999');
});

test('parseNetstatPid ignores an ESTABLISHED row on the same port and returns null when nothing is listening', () => {
  assert.equal(parseNetstatPid(englishNetstat, 9), null);
});

test('parseLsofPids takes the first pid line, null when empty', () => {
  assert.equal(parseLsofPids('1234\n5678\n'), '1234');
  assert.equal(parseLsofPids(''), null);
  assert.equal(parseLsofPids(null), null);
});

// Built with the running OS's own path rules: a `C:\...` literal is not
// absolute on Linux/macOS, which made these pass or fail by accident there (CI).
const SERVER_PATH = path.resolve(path.sep, 'opt', 'ResumerAgent', 'server.mjs');
const OTHER_SERVER = path.resolve(path.sep, 'opt', 'OtherProject', 'server.mjs');
const NODE = `"${process.execPath}"`;

test('isOurServer accepts the bare relative "server.mjs" this script spawns itself with', () => {
  assert.equal(isOurServer(`${NODE} server.mjs`, SERVER_PATH), true);
});

test('isOurServer accepts an absolute path that resolves to this repo\'s server.mjs', () => {
  assert.equal(isOurServer(`${NODE} "${SERVER_PATH}"`, SERVER_PATH), true);
});

test('isOurServer rejects an absolute path to a same-named server.mjs in a different project', () => {
  assert.equal(isOurServer(`${NODE} "${OTHER_SERVER}"`, SERVER_PATH), false);
});

test('isOurServer rejects an unrelated node process entirely', () => {
  assert.equal(isOurServer(`${NODE} app.js`, SERVER_PATH), false);
});

test('isOurServer rejects a missing/unreadable command line', () => {
  assert.equal(isOurServer(null, SERVER_PATH), false);
  assert.equal(isOurServer('', SERVER_PATH), false);
});

test('waitUntil resolves true immediately when the check already passes, without sleeping', async () => {
  let sleeps = 0;
  const ok = await waitUntil(() => true, { sleep: async () => { sleeps++; } });
  assert.equal(ok, true);
  assert.equal(sleeps, 0);
});

test('waitUntil retries on a fake clock until the check passes, bounded by timeoutMs', async () => {
  let clock = 0;
  let calls = 0;
  const check = () => { calls++; return calls >= 3; };
  const ok = await waitUntil(check, {
    timeoutMs: 1000,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('waitUntil gives up and returns false once the fake clock passes the deadline', async () => {
  let clock = 0;
  const ok = await waitUntil(() => false, {
    timeoutMs: 500,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(ok, false);
});
