import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pauseBackgroundSession } from './pauseSession.mjs';

// The two things worth checking on a thin CLI wrapper: it passes the id
// through as the real ["stop", id] argv `claude` expects (not dropped or
// reordered), and a failing CLI call surfaces as a rejection rather than a
// silently-swallowed success — server.mjs's /api/pause treats any thrown
// error here as a failed pause and reports it to the client.
test('invokes claude stop with the session id and propagates CLI failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-pausesession-test-'));
  const scriptPath = path.join(dir, 'fake-claude.mjs');
  const argsLogPath = path.join(dir, 'args.json');
  fs.writeFileSync(
    scriptPath,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(argsLogPath)}, JSON.stringify(process.argv.slice(2)));
     if (process.argv[3] === 'fail-me') { process.exitCode = 1; }`
  );

  await pauseBackgroundSession('abc123', `node "${scriptPath}"`);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsLogPath, 'utf8')), ['stop', 'abc123']);

  await assert.rejects(() => pauseBackgroundSession('fail-me', `node "${scriptPath}"`));
});
