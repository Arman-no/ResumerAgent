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
    { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'cost-state', totalCostUSD: 1.23 },
    { type: 'user', message: { content: 'a second message' } },
    { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 500, cache_creation_input_tokens: 1000, cache_read_input_tokens: 98500 } } },
    { type: 'cost-state', totalCostUSD: 4.56 },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.costUsd, 4.56, 'should pick the most recent cost-state, not the first');
  assert.equal(result.contextUsedPercent, 50, '(500 + 1000 + 98500) / 200_000 = 50% (Haiku 4.5 stays at the 200k baseline)');
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

// Regression test for the "100% ctx" bug: a session on a current-gen model
// (1M context is that model's real default, not an opt-in beta) must not
// have its usage divided by a blind 200k assumption — that overflows past
// 100%, gets clamped, and renders as a maxed-red bar for a session that in
// reality has barely used a tenth of its real window.
test('a current-gen model (1M default context) is not divided by 200k', () => {
  const file = writeFixture([
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 2, cache_creation_input_tokens: 622, cache_read_input_tokens: 126611 },
      },
    },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  // (2 + 622 + 126611) / 1_000_000 ≈ 12.72% — nowhere near the ~63.6% (and
  // definitely not the clamped 100%) that dividing by 200k would have shown.
  assert.ok(result.contextUsedPercent < 15, `expected well under 15%, got ${result.contextUsedPercent}`);
});

test('a legacy/older model without a confirmed 1M default still uses the 200k baseline', () => {
  const file = writeFixture([
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.contextUsedPercent, 50, '100_000 / 200_000 = 50%');
});

// Regression, confirmed 2026-09-14 against real transcripts: Claude Code
// writes `agent-name`/`agentName` (explicit) and `ai-title`/`aiTitle`
// (auto-generated) — never the `custom-title`/`customTitle` shape this
// lookup originally checked for, which matched nothing on real data and
// left every dead/renamed session showing "No Name".
test('an explicit agent-name is picked up as the custom name', () => {
  const file = writeFixture([
    { type: 'agent-name', agentName: 'PHOENIX-18579' },
    { type: 'user', message: { content: 'status check' } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.customName, 'PHOENIX-18579');
});

test('an auto-generated ai-title is picked up as the custom name when there is no agent-name', () => {
  const file = writeFixture([
    { type: 'ai-title', aiTitle: 'PHOENIX-18563' },
    { type: 'user', message: { content: 'status check' } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.customName, 'PHOENIX-18563');
});

test('a turn with no model field is skipped, not treated as 200k by default', () => {
  const file = writeFixture([
    // No model on this turn — real Claude Code transcripts always carry
    // one, but the code must not silently guess a window size for a
    // malformed/unexpected line rather than fabricate a percentage.
    { type: 'assistant', message: { usage: { input_tokens: 500000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.contextUsedPercent, null);
});

// Regression for the real PHOENIX-18619 transcript: cost-state is written
// periodically, not every turn, so on a long session the newest one can sit
// well past MAX_TAIL_BYTES. Padding pushes the cost-state line outside the
// 2MB tail so only the backward chunk scan over the rest of the file can find it.
test('costUsd outside the 2MB tail read is still found by the backward chunk scan', () => {
  const padding = 'x'.repeat(2_100_000);
  const file = writeFixture([
    { type: 'cost-state', totalCostUSD: 12.34 },
    { type: 'user', message: { content: padding } },
    { type: 'user', message: { content: 'last message' } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.costUsd, 12.34);
  assert.equal(result.preview, 'last message');
});

// Regression for the real PHOENIX-18619/-18563 transcripts: a manual
// /compact with no assistant turn after it (the compact was the last thing
// in the file) must size contextUsedPercent off compactMetadata.postTokens
// against the model from the nearest earlier assistant turn — not off that
// turn's own pre-compaction usage, which would wildly overstate it.
test('a compact_boundary with no later assistant turn uses postTokens against the preceding turn\'s model', () => {
  const file = writeFixture([
    { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_creation_input_tokens: 900000, cache_read_input_tokens: 0 } } },
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 900002, postTokens: 40000 } },
    { type: 'user', message: { content: 'continuing after compact' } },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.contextUsedPercent, 4, '40_000 / 1_000_000 = 4%, not the pre-compaction ~90%');
});

// Regression for the real MonitoringAgent/ObsidianAgent transcripts: the
// scan must keep going until contextUsedPercent is resolved too, not just
// stop once preview/customName/costUsd happen to be satisfied first — those
// three land within a few lines of EOF almost every turn (ai-title, cost-state),
// while the assistant turn carrying usage can sit a little further back.
test('contextUsedPercent is still found even after preview, customName and costUsd are already resolved', () => {
  const file = writeFixture([
    { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_creation_input_tokens: 99998, cache_read_input_tokens: 0 } } },
    { type: 'user', message: { content: 'an earlier message, not the preview' } },
    { type: 'agent-name', agentName: 'TestAgent' },
    { type: 'cost-state', totalCostUSD: 3.21 },
    { type: 'system', subtype: 'away_summary', content: 'a recap that becomes the preview' },
  ]);

  const result = readTranscriptPreviewFromFile(file);
  assert.equal(result.preview, 'a recap that becomes the preview');
  assert.equal(result.customName, 'TestAgent');
  assert.equal(result.costUsd, 3.21);
  assert.equal(result.contextUsedPercent, 10, '(2 + 99998) / 1_000_000 = 10%, found despite sitting before the other three');
});
