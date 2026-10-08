import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectBillingMode } from './billingMode.mjs';

function rootWithSettings(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'settings.json'), content);
  return dir;
}

test('Bedrock from settings.json env block', () => {
  const sessionsRoot = rootWithSettings(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.deepEqual(detectBillingMode({ env: {}, sessionsRoot }), { mode: 'api', provider: 'Amazon Bedrock' });
});

test('process env overrides settings.json, falsy strings do not count', () => {
  const sessionsRoot = rootWithSettings(JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
  assert.deepEqual(
    detectBillingMode({ env: { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'true' }, sessionsRoot }),
    { mode: 'api', provider: 'Google Vertex AI' },
  );
});

test('Foundry and Anthropic API key', () => {
  assert.deepEqual(detectBillingMode({ env: { CLAUDE_CODE_USE_FOUNDRY: '1' } }), { mode: 'api', provider: 'Microsoft Foundry' });
  assert.deepEqual(detectBillingMode({ env: { ANTHROPIC_API_KEY: 'sk-secret' } }), { mode: 'api', provider: 'Anthropic API' });
});

test('no signal, missing or invalid settings.json -> subscription, never leaks env values', () => {
  for (const content of [undefined, '{not json', JSON.stringify({ env: 'x' })]) {
    const result = detectBillingMode({ env: {}, sessionsRoot: rootWithSettings(content) });
    assert.deepEqual(result, { mode: 'subscription', provider: null });
  }
  assert.ok(!JSON.stringify(detectBillingMode({ env: { ANTHROPIC_API_KEY: 'sk-secret' } })).includes('sk-secret'));
});
