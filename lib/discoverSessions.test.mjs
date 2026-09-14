import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSessions } from './discoverSessions.mjs';

// Synthetic fixture only — never a real transcript (see AGENT_SETUP.md's
// hard rules).
function writeFixtureTranscript(lines) {
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-discover-test-'));
  const projectDir = path.join(sessionsRoot, 'projects', 'C--fake-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'fake-session-id.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionsRoot;
}

// Regression, confirmed 2026-09-14 against a real background-agent
// transcript (PHOENIX-18579): several KB of ai-title/agent-name/mode/
// file-history-snapshot lines can precede the first cwd-bearing line —
// that real session's cwd landed at ~18KB in. The old 8KB head-scan
// cutoff silently dropped it from discovery entirely.
test('finds cwd past the old 8KB cutoff, within the new head-scan window', () => {
  const paddingLine = { type: 'file-history-snapshot', snapshot: { junk: 'x'.repeat(2000) } };
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(paddingLine); // ~20KB of padding
  lines.push({ type: 'user', cwd: 'C:\\GitRepos\\dwh_il', gitBranch: 'Release/3.54', message: { content: 'hi' } });

  const sessionsRoot = writeFixtureTranscript(lines);
  const sessions = discoverSessions(sessionsRoot, 30 * 24 * 60 * 60 * 1000);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, 'C:\\GitRepos\\dwh_il');
  assert.equal(sessions[0].gitBranch, 'Release/3.54');
});
