import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscriptPreviewFromFile } from './transcriptPreview.mjs';

// Synthetic fixture only — never a real transcript (see AGENT_SETUP.md's
// hard rules). Written with node:fs directly rather than a shell heredoc,
// since heredocs have a known history of mangling Windows paths/quoting.
function writeFixture(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-test-')), 'fake-session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('extracts the last cost-state total and approximates context usage from the last assistant turn', () => {
  const file = writeFixture([
    { type: 'user', message: { content: 'hello there' } },
    { type: 'assistant', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'cost-state', totalCostUSD: 1.23 },
    { type: 'user', message: { content: 'a second message' } },
    { type: 'assistant', message: { usage: { input_tokens: 500, cache_creation_input_tokens: 1000, cache_read_input_tokens: 98500 } } },
    { type: 'cost-state', totalCostUSD: 4.56 },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.costUsd, 4.56, 'should pick the most recent cost-state, not the first');
  assert.equal(result.contextUsedPercent, 50, '(500 + 1000 + 98500) / 200_000 = 50%');
  assert.equal(result.preview, 'a second message');
});

test('missing cost-state/usage data degrades to null, not a crash', () => {
  const file = writeFixture([
    { type: 'user', message: { content: 'just one message, no assistant turn yet' } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.costUsd, null);
  assert.equal(result.contextUsedPercent, null);
  assert.equal(result.preview, 'just one message, no assistant turn yet');
});
