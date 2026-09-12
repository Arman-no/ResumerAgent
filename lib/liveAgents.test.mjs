import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLiveAgents } from './liveAgents.mjs';

// Regression for the 2026-09-12 "every session shows status unknown / live
// count reads 0" incident: `claude agents --json --all` legitimately takes
// several seconds on a machine with many tracked sessions (measured
// 2.2s-6.3s live), and the old 5000ms timeout treated that normal slowness
// as a failure — returning null, which mergeSessions.mjs then fans out into
// liveUnknown: true for every session. This stands in a fake "CLI" that's
// slow but succeeds, well past the old timeout, comfortably under the
// current one — it must resolve to real data, not null.
test('tolerates a slow-but-successful CLI call without giving up on liveness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-liveagents-test-'));
  const scriptPath = path.join(dir, 'slow-claude.mjs');
  fs.writeFileSync(
    scriptPath,
    "setTimeout(function () { process.stdout.write(JSON.stringify([{ sessionId: 'abc', kind: 'interactive', cwd: 'C:\\\\x', status: 'busy' }])); }, 6000);"
  );

  const result = await readLiveAgents('node', [scriptPath]);
  assert.ok(Array.isArray(result), 'expected a parsed array, not null (a timed-out/failed call)');
  assert.equal(result[0].sessionId, 'abc');
});
