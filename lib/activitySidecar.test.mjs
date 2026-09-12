import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readActivitySidecar } from './activitySidecar.mjs';

function makeSessionsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-sidecar-test-'));
}

test('strips a UTF-8 BOM before parsing (PowerShell Out-File default)', () => {
  const root = makeSessionsRoot();
  fs.mkdirSync(path.join(root, 'activity'));
  const payload = { session_id: 'abc', cost: { total_cost_usd: 1.23 }, rate_limits: null };
  fs.writeFileSync(path.join(root, 'activity', 'abc.json'), '﻿' + JSON.stringify(payload));

  const result = readActivitySidecar(root, 'abc');
  assert.equal(result.cost.total_cost_usd, 1.23);
});

test('missing sidecar file returns null, not a throw', () => {
  const root = makeSessionsRoot();
  assert.equal(readActivitySidecar(root, 'does-not-exist'), null);
});
