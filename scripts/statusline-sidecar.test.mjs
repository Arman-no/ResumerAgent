import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline-sidecar.mjs');
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function run(payload, configDir) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-statusline-test-'));
}

test('full payload (with rate_limits) writes sidecar shape and prints a status line', () => {
  const root = tmpConfigDir();
  const payload = {
    session_id: SESSION_ID,
    session_name: 'my-session',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    cwd: '/cwd-fallback',
    workspace: { current_dir: '/current/working/directory' },
    cost: { total_cost_usd: 821.9369, total_duration_ms: 45000 },
    context_window: { used_percentage: 4, context_window_size: 200000 },
    rate_limits: {
      // +30s buffer: resets_at - now() must still floor to "36m" after the
      // few hundred ms a spawned process takes to run.
      five_hour: { used_percentage: 19, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 + 36 * 60 + 30 },
      seven_day: { used_percentage: 41.2, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  };

  const result = run(payload, root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Opus 5\.5/);
  assert.match(result.stdout, /ctx 4%/);
  assert.match(result.stdout, /\$821\.94/);
  assert.match(result.stdout, /5h 19% \(resets 3h 36m\)/);

  const sidecarPath = path.join(root, 'activity', `${SESSION_ID}.json`);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert.equal(sidecar.session_id, SESSION_ID);
  assert.equal(sidecar.session_name, 'my-session');
  assert.equal(sidecar.model, 'Opus 5.5');
  assert.equal(sidecar.cwd, '/current/working/directory');
  assert.equal(sidecar.git_branch, null);
  assert.equal(typeof sidecar.updated_at, 'number');
  assert.deepEqual(sidecar.context_window, { used_percentage: 4, context_window_size: 200000 });
  assert.deepEqual(sidecar.cost, { total_cost_usd: 821.9369, total_duration_ms: 45000 });
  assert.equal(sidecar.rate_limits.five_hour.used_percentage, 19);
  assert.equal(sidecar.rate_limits.seven_day.used_percentage, 41.2);
});

test('API/Bedrock-style payload with no rate_limits field writes rate_limits: null', () => {
  const root = tmpConfigDir();
  const payload = {
    session_id: SESSION_ID,
    model: { display_name: 'Sonnet 5' },
    workspace: { current_dir: '/wd' },
    cost: { total_cost_usd: 1.5 },
    context_window: { used_percentage: 10, context_window_size: 200000 },
    // no rate_limits key at all — Bedrock/Vertex/API billing
  };

  const result = run(payload, root);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /resets/);

  const sidecar = JSON.parse(fs.readFileSync(path.join(root, 'activity', `${SESSION_ID}.json`), 'utf8'));
  assert.equal(sidecar.rate_limits, null);
});

test('malformed stdin exits 0 without throwing and prints a fallback line', () => {
  const root = tmpConfigDir();
  const result = run('not json {{{', root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.trim().length > 0);
});

test('non-UUID session_id does not write a sidecar file (path-traversal guard)', () => {
  const root = tmpConfigDir();
  const payload = { session_id: '../../etc/passwd', model: { display_name: 'Opus' } };
  const result = run(payload, root);
  assert.equal(result.status, 0);

  const activityDir = path.join(root, 'activity');
  assert.ok(!fs.existsSync(activityDir) || fs.readdirSync(activityDir).length === 0);
});

function runWithArgs(payload, configDir, extraArgs) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

function base64(command) {
  return Buffer.from(command, 'utf8').toString('base64');
}

test('--chain runs the original command and prints its stdout unchanged, sidecar still written', () => {
  const root = tmpConfigDir();
  const payload = {
    session_id: SESSION_ID,
    model: { display_name: 'Sonnet 5' },
    workspace: { current_dir: '/wd' },
    context_window: { used_percentage: 1 },
  };
  // Portable across cmd/PowerShell/sh: node -e reading stdin and echoing a
  // fixed marker, rather than a shell-specific echo/printf.
  const original = `"${process.execPath}" -e "process.stdin.resume();process.stdout.write('ORIGINAL-STATUSLINE')"`;

  const result = runWithArgs(payload, root, ['--chain', base64(original)]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ORIGINAL-STATUSLINE');

  const sidecarPath = path.join(root, 'activity', `${SESSION_ID}.json`);
  assert.ok(fs.existsSync(sidecarPath));
});

test('--chain falls back to its own line when the original command fails', () => {
  const root = tmpConfigDir();
  const payload = {
    session_id: SESSION_ID,
    model: { display_name: 'Sonnet 5' },
    workspace: { current_dir: '/wd' },
  };
  const failing = `"${process.execPath}" -e "process.exit(1)"`;

  const result = runWithArgs(payload, root, ['--chain', base64(failing)]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Sonnet 5/);
});
