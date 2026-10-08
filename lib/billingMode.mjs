import fs from 'node:fs';
import path from 'node:path';

// Rate limits (5-hour / weekly) exist only on Claude.ai subscription plans;
// Claude Code never reports them on API billing. These are the env switches
// Claude Code itself reads to pick a provider, checked in its own precedence
// order. process.env wins over settings.json's `env` block, like Claude Code.
const PROVIDERS = [
  ['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry'],
];

function isTruthy(value) {
  return Boolean(value) && !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function readSettingsEnv(sessionsRoot) {
  try {
    const env = JSON.parse(fs.readFileSync(path.join(sessionsRoot, 'settings.json'), 'utf8')).env;
    return env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  } catch {
    return {}; // missing, unreadable or not JSON: no settings-level signal
  }
}

// Returns only {mode, provider}, never an env value, so it is safe to send
// to the client as-is.
export function detectBillingMode({ env = process.env, sessionsRoot } = {}) {
  const merged = { ...(sessionsRoot ? readSettingsEnv(sessionsRoot) : {}), ...env };
  for (const [key, provider] of PROVIDERS) {
    if (isTruthy(merged[key])) return { mode: 'api', provider };
  }
  if (merged.ANTHROPIC_API_KEY) return { mode: 'api', provider: 'Anthropic API' };
  // ponytail: assumed, not proven — a claude.ai login leaves no env signal
  // (apiKeyHelper / OAuth token in the keychain aren't checked).
  return { mode: 'subscription', provider: null };
}
