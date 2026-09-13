import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeInteractiveSession } from './closeSession.mjs';

// A no-parent-found stand-in shared by tests that aren't exercising the
// terminal-mode reset step — prints nothing, so getParentPid() parses NaN
// and returns null, which skips the reset step cleanly instead of these
// tests spawning a real powershell.exe.
function writeNoopPowershellStub(scriptPath) {
  fs.writeFileSync(scriptPath, `process.stdout.write('');`);
}

// The two things worth checking: the process-tree end command gets exactly
// ["/PID", pid, "/T", "/F"] (the /T matters — see closeSession.mjs's own
// comment on why a non-tree kill leaves orphaned helper processes behind),
// and the PID-reuse guard actually refuses to act when a fresh lookup no
// longer shows a claude.exe at that PID, rather than acting on stale data.
// Regression coverage included for the real quoting bug found live
// 2026-09-13: the filter value must survive as one argument, not get
// re-split by a shell — these fakes would fail the same way tasklist did
// if that ever regressed, since argsPrefix routes through the same
// execFile call with no shell involved.
test('ends the process tree when a fresh lookup confirms a real claude.exe PID', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-closesession-test-'));
  const lookupScript = path.join(dir, 'fake-lookup.mjs');
  const endTreeScript = path.join(dir, 'fake-endtree.mjs');
  const noopPowershellScript = path.join(dir, 'fake-powershell-noop.mjs');
  const lookupArgsLog = path.join(dir, 'lookup-args.json');
  const endTreeArgsLog = path.join(dir, 'endtree-args.json');

  fs.writeFileSync(
    lookupScript,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(lookupArgsLog)}, JSON.stringify(process.argv.slice(2)));
     process.stdout.write('"claude.exe","12345","Console","1","300,000 K"');`
  );
  fs.writeFileSync(
    endTreeScript,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(endTreeArgsLog)}, JSON.stringify(process.argv.slice(2)));`
  );
  writeNoopPowershellStub(noopPowershellScript);

  await closeInteractiveSession(12345, {
    tasklistCommand: 'node',
    tasklistArgsPrefix: [lookupScript],
    taskkillCommand: 'node',
    taskkillArgsPrefix: [endTreeScript],
    powershellCommand: 'node',
    powershellArgsPrefix: [noopPowershellScript],
  });

  // Confirms the filter value arrived as one argv element, not split by a
  // shell into ["/FI", "PID", "eq", "12345", ...] the way the real bug did.
  // process.argv.slice(2) in the fake script is everything after the
  // script path itself (argsPrefix), i.e. just the real call's own args.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(lookupArgsLog, 'utf8')),
    ['/FI', 'PID eq 12345', '/FO', 'CSV', '/NH']
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(endTreeArgsLog, 'utf8')),
    ['/PID', '12345', '/T', '/F']
  );
});

// Regression, confirmed live 2026-09-13: a real MCP helper process exited
// on its own between taskkill enumerating the tree and reaching that one
// member, so taskkill's overall exit code was non-zero ("no running
// instance of the task") even though the actual target PID was already
// gone. The fake tasklist here answers "still claude.exe" on its first
// call (the pre-check) and "gone" on its second (the post-failure
// re-check) — closeInteractiveSession must treat that combination as
// success, not surface the taskkill error.
test('a taskkill failure is not an error when the target pid is confirmed gone on re-check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-closesession-test-'));
  const lookupScript = path.join(dir, 'fake-lookup-then-gone.mjs');
  const endTreeScript = path.join(dir, 'fake-endtree-fails.mjs');
  const noopPowershellScript = path.join(dir, 'fake-powershell-noop.mjs');
  const callCountFile = path.join(dir, 'call-count.txt');

  fs.writeFileSync(
    lookupScript,
    `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
     const countFile = ${JSON.stringify(callCountFile)};
     const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
     writeFileSync(countFile, String(count + 1));
     if (count === 0) {
       process.stdout.write('"claude.exe","12345","Console","1","300,000 K"');
     } else {
       process.stdout.write('INFO: No tasks are running which match the specified criteria.');
     }`
  );
  fs.writeFileSync(
    endTreeScript,
    `console.error('ERROR: The process with PID 99999 (child process of PID 12345) could not be terminated.');
     process.exitCode = 128;`
  );
  writeNoopPowershellStub(noopPowershellScript);

  await closeInteractiveSession(12345, {
    tasklistCommand: 'node',
    tasklistArgsPrefix: [lookupScript],
    taskkillCommand: 'node',
    taskkillArgsPrefix: [endTreeScript],
    powershellCommand: 'node',
    powershellArgsPrefix: [noopPowershellScript],
  });
  // No assertion needed beyond "did not throw" — that's the whole bug.
});

test('refuses to act when the fresh lookup no longer shows a claude.exe at that PID (possible PID reuse)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-closesession-test-'));
  const lookupScript = path.join(dir, 'fake-lookup-empty.mjs');
  const endTreeScript = path.join(dir, 'fake-endtree-should-not-run.mjs');
  const endTreeArgsLog = path.join(dir, 'endtree-args.json');

  fs.writeFileSync(lookupScript, `process.stdout.write('INFO: No tasks are running which match the specified criteria.');`);
  fs.writeFileSync(
    endTreeScript,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(endTreeArgsLog)}, 'SHOULD NOT HAVE RUN');`
  );

  // No powershell override needed — isStillClaudeProcess fails first and
  // this throws before getParentPid() is ever called.
  await assert.rejects(() =>
    closeInteractiveSession(99999, {
      tasklistCommand: 'node',
      tasklistArgsPrefix: [lookupScript],
      taskkillCommand: 'node',
      taskkillArgsPrefix: [endTreeScript],
    })
  );
  assert.equal(fs.existsSync(endTreeArgsLog), false);
});

// The actual fix for the real bug reported 2026-09-13 (mouse-tracking
// escape codes garbling the surviving terminal after Close): the parent
// pid must be looked up BEFORE the kill (the target is gone afterward,
// so nothing could ask "what was its parent"), and the reset script must
// then be invoked with exactly that pid, after the kill succeeds.
test('looks up the parent pid before the kill and runs the reset script with it after', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-closesession-test-'));
  const lookupScript = path.join(dir, 'fake-lookup.mjs');
  const endTreeScript = path.join(dir, 'fake-endtree.mjs');
  const powershellScript = path.join(dir, 'fake-powershell.mjs');
  const resetArgsLog = path.join(dir, 'reset-args.json');

  fs.writeFileSync(lookupScript, `process.stdout.write('"claude.exe","12345","Console","1","300,000 K"');`);
  fs.writeFileSync(endTreeScript, `process.exitCode = 0;`);
  // Routes on which of the two real invocations it's standing in for:
  // -Command (the CIM parent-pid lookup, before the kill) prints a fake
  // parent pid; -File (the reset script, after the kill) logs its args.
  fs.writeFileSync(
    powershellScript,
    `import { writeFileSync } from 'node:fs';
     const args = process.argv.slice(2);
     if (args.includes('-Command')) {
       process.stdout.write('54321');
     } else if (args.includes('-File')) {
       writeFileSync(${JSON.stringify(resetArgsLog)}, JSON.stringify(args));
     }`
  );

  await closeInteractiveSession(12345, {
    tasklistCommand: 'node',
    tasklistArgsPrefix: [lookupScript],
    taskkillCommand: 'node',
    taskkillArgsPrefix: [endTreeScript],
    powershellCommand: 'node',
    powershellArgsPrefix: [powershellScript],
    resetScriptPath: 'fake-reset-script.ps1',
  });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(resetArgsLog, 'utf8')),
    ['-NoProfile', '-File', 'fake-reset-script.ps1', '-ParentPid', '54321']
  );
});

// The reset step is best-effort by design — a session this app just
// closed is already closed regardless of whether this cosmetic cleanup
// succeeds, so a failure here must never surface as a failed close.
test('a failing reset script does not fail the overall close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-closesession-test-'));
  const lookupScript = path.join(dir, 'fake-lookup.mjs');
  const endTreeScript = path.join(dir, 'fake-endtree.mjs');
  const powershellScript = path.join(dir, 'fake-powershell-fails.mjs');

  fs.writeFileSync(lookupScript, `process.stdout.write('"claude.exe","12345","Console","1","300,000 K"');`);
  fs.writeFileSync(endTreeScript, `process.exitCode = 0;`);
  fs.writeFileSync(
    powershellScript,
    `const args = process.argv.slice(2);
     if (args.includes('-Command')) {
       process.stdout.write('54321');
     } else if (args.includes('-File')) {
       process.exitCode = 1;
     }`
  );

  await closeInteractiveSession(12345, {
    tasklistCommand: 'node',
    tasklistArgsPrefix: [lookupScript],
    taskkillCommand: 'node',
    taskkillArgsPrefix: [endTreeScript],
    powershellCommand: 'node',
    powershellArgsPrefix: [powershellScript],
  });
  // No assertion needed beyond "did not throw".
});
