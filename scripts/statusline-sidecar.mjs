#!/usr/bin/env node
// Optional Claude Code statusLine command. Writes the activity sidecar that
// lib/activitySidecar.mjs reads (<root>/activity/<session_id>.json), so the
// dashboard can show cost/context/rate-limits for sessions that never wrote
// a transcript cost-state line (e.g. a live session with no cost line yet).
//
// Must never fail the user's statusline: every failure path below still
// prints a line and exits 0 rather than throwing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function money(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

function pct(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

// resets_at is unix seconds (per Claude Code's statusline JSON schema).
function resetIn(resetsAt) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  const seconds = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function buildStatusLine(payload) {
  const parts = [];
  if (payload?.model?.display_name) parts.push(payload.model.display_name);

  const ctx = pct(payload?.context_window?.used_percentage);
  if (ctx) parts.push(`ctx ${ctx}`);

  const cost = money(payload?.cost?.total_cost_usd);
  if (cost) parts.push(cost);

  let line = parts.join(' · ') || 'statusline-sidecar';

  const fiveHour = payload?.rate_limits?.five_hour;
  const fiveHourPct = pct(fiveHour?.used_percentage);
  if (fiveHourPct) {
    const resets = resetIn(fiveHour.resets_at);
    line += ` · 5h ${fiveHourPct}${resets ? ` (resets ${resets})` : ''}`;
  }

  return line;
}

// Shape documented in lib/activitySidecar.mjs. Null (never {}) for anything
// missing from the payload.
function buildSidecar(payload) {
  const cw = payload?.context_window;
  const contextWindow = typeof cw?.used_percentage === 'number'
    ? { used_percentage: cw.used_percentage, context_window_size: cw.context_window_size ?? null }
    : null;

  const rl = payload?.rate_limits;
  const rateLimits = rl?.five_hour || rl?.seven_day
    ? { five_hour: rl.five_hour ?? null, seven_day: rl.seven_day ?? null }
    : null;

  const cost = payload?.cost;
  const costOut = typeof cost?.total_cost_usd === 'number'
    ? { total_cost_usd: cost.total_cost_usd, total_duration_ms: cost.total_duration_ms ?? null }
    : null;

  return {
    session_id: payload.session_id,
    session_name: payload?.session_name ?? null,
    model: payload?.model?.display_name ?? null,
    cwd: payload?.workspace?.current_dir ?? payload?.cwd ?? null,
    // Never shelled out to git here — this must stay fast, and the
    // statusline payload carries no plain branch name of its own.
    git_branch: null,
    updated_at: Math.floor(Date.now() / 1000),
    context_window: contextWindow,
    rate_limits: rateLimits,
    cost: costOut,
  };
}

function writeSidecarAtomically(root, sessionId, sidecar) {
  const activityDir = path.join(root, 'activity');
  fs.mkdirSync(activityDir, { recursive: true });
  const target = path.join(activityDir, `${sessionId}.json`);
  const tmp = path.join(activityDir, `.${sessionId}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(sidecar));
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Windows refuses the rename while a reader holds the target open; drop
    // the temp file so every refresh doesn't leave one behind.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// --chain <base64 of a shell command>: setup-statusline.mjs passes this
// when the user already had a statusline, so both still run. Decoded with
// a plain Buffer round-trip — base64 of UTF-8 survives unquoted as a single
// argv token on cmd.exe, PowerShell, Git Bash and POSIX sh alike, which the
// original command string (quotes, `&`, `|`, `$`, backticks, ...) would not.
function parseChainArg(argv) {
  const idx = argv.indexOf('--chain');
  if (idx === -1 || idx + 1 >= argv.length) return null;
  try {
    return Buffer.from(argv[idx + 1], 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// Runs the user's original statusline command with the same stdin payload
// we got, so it sees the identical JSON. Returns its stdout verbatim on a
// clean, on-time success, or null on any failure/timeout — callers fall
// back to this script's own line rather than printing nothing.
function runChained(command, rawStdin) {
  try {
    const result = spawnSync(command, {
      shell: true,
      input: rawStdin,
      timeout: 5000,
      encoding: 'utf8',
    });
    if (!result.error && result.status === 0 && typeof result.stdout === 'string') {
      return result.stdout;
    }
  } catch {
    // fall through to null
  }
  return null;
}

function main() {
  let statusLine = 'statusline-sidecar';
  let rawStdin = '';
  try {
    rawStdin = readStdin();
    let payload = {};
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      payload = {};
    }

    statusLine = buildStatusLine(payload);

    const sessionId = payload?.session_id;
    if (typeof sessionId === 'string' && UUID_RE.test(sessionId)) {
      const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      writeSidecarAtomically(root, sessionId, buildSidecar(payload));
    }
  } catch {
    // Never fail the user's statusline over a sidecar-writing problem.
  }

  const chainCommand = parseChainArg(process.argv.slice(2));
  if (chainCommand) {
    const chainedOutput = runChained(chainCommand, rawStdin);
    if (chainedOutput !== null) {
      process.stdout.write(chainedOutput);
      return;
    }
    // original failed or timed out — fall back to our own line below
  }

  process.stdout.write(statusLine + '\n');
}

main();
