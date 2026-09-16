#!/usr/bin/env node
// Dev-only script. NOT part of the app — nothing under lib/ or server.mjs
// imports this. Its only job is regenerating docs/images/demo.gif (and the
// static screenshots next to it): it builds a fake SESSIONS_ROOT populated
// with invented sessions, so a maintainer can point a throwaway
// `node server.mjs` at it and record/screenshot the dashboard without ever
// touching a real ~/.claude directory.
//
// Usage:
//   node scripts/seed-demo.mjs [outDir]
//     outDir defaults to a fresh temp directory (printed on stdout).
//
//   DEMO_LIVE_PID=<pid> node scripts/seed-demo.mjs [outDir]
//     The 3 "live" sessions need a *currently running* OS pid — liveAgents.mjs
//     ultimately checks isPidAlive() against it. Pass the pid of some
//     long-lived process you started for the recording (a keep-alive `node
//     -e "setInterval(()=>{},60000)"`, or the demo server's own pid). Falls
//     back to this script's own pid, which is only useful if something reads
//     the seed while this process is still alive — never true once
//     server.mjs actually starts, so pass a real one for an actual recording.
//
// This also writes <outDir>/live-agents.demo.json — the JSON array a
// `claude agents --json --all` shim should print (see lib/liveAgents.mjs).
// Not read by the app itself; it's just the one source of truth for the pids/
// ids/statuses the seeded registry+transcripts already agree on, so a PATH
// shim can `type`/cat it instead of duplicating this data a second time.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwdForProjectDir } from '../lib/pathEncoding.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.now();

const LIVE_PID = Number.parseInt(process.env.DEMO_LIVE_PID, 10) || process.pid;

// The cast this mirrors docs/images/dashboard-dark.png's own 8 sessions:
// a mix of live (idle/working/busy) and resumable, one nearing its
// cleanup-driven expiry. All names, paths, ids and cost/usage numbers below
// are invented — none of it is real session data.
const SESSIONS = [
  {
    name: 'docs-site', sessionId: 'bec185b1-4d49-4b41-b3d8-97eab3f99c10',
    cwd: '/home/dev/work/docs-site', gitBranch: 'main', kind: 'interactive',
    live: true, status: 'idle',
    preview: 'Regenerate the API reference pages from the new OpenAPI spec',
    costUsd: 0.64, contextUsedPercent: 18, rateLimits: null,
    updatedAgoMs: 7 * MIN,
  },
  {
    name: 'checkout-flow', sessionId: 'ed394831-205e-4e36-9e02-2490f8678d0b',
    cwd: '/home/dev/work/checkout-flow', gitBranch: 'feature/stripe-webhooks', kind: 'background',
    live: true, status: 'working', jobId: '9c9c7e2a-7c9b-4b0e-9f0a-1a9f7a8b6c3d',
    preview: 'Add idempotency keys to the payment webhook handler',
    costUsd: 3.47, contextUsedPercent: 72, rateLimits: null,
    updatedAgoMs: 12 * MIN,
  },
  {
    name: 'api-gateway', sessionId: 'd6da833f-49e3-4cdb-a1ff-2f1568eb2898',
    cwd: 'C:\\projects\\api-gateway', gitBranch: 'main', kind: 'interactive',
    live: true, status: 'busy',
    preview: 'Fix the rate limiter middleware so it respects the X-Forwarded-For header',
    costUsd: 1.82, contextUsedPercent: 35,
    rateLimits: { five_hour: 18, seven_day: 22 }, rateLimitsAgoMs: 25 * MIN,
    updatedAgoMs: 26 * MIN,
  },
  {
    name: 'mobile-app', sessionId: '13ed1281-7eed-4759-8909-4985c97b5eeb',
    cwd: 'C:\\projects\\mobile-app', gitBranch: 'main', kind: 'interactive',
    live: false,
    preview: 'Wire up push notification permissions for the onboarding flow',
    costUsd: 2.10, contextUsedPercent: 45, rateLimits: null,
    updatedAgoMs: 6 * HOUR,
  },
  {
    name: 'billing-service', sessionId: '73f8b72d-4f92-4548-b219-07dd41d8b271',
    cwd: '/home/dev/work/billing-service', gitBranch: 'fix/invoice-rounding', kind: 'interactive',
    live: false,
    preview: 'Round invoice line totals to the nearest cent before tax is applied',
    costUsd: 1.15, contextUsedPercent: 89, rateLimits: null,
    updatedAgoMs: 12 * HOUR,
  },
  {
    name: 'infra-terraform', sessionId: '85089135-e61c-4908-93e4-2ed35261f3df',
    cwd: 'C:\\projects\\infra-terraform', gitBranch: 'main', kind: 'interactive',
    live: false,
    preview: 'Split the networking module out of the monolithic root stack',
    costUsd: 0.38, contextUsedPercent: 12, rateLimits: null,
    updatedAgoMs: 2 * DAY,
  },
  {
    name: 'design-system', sessionId: '5b5053dd-2b3c-4161-8bc8-8fd824b99a2f',
    cwd: 'C:\\projects\\design-system', gitBranch: 'main', kind: 'interactive',
    live: false,
    preview: 'Add the new elevation tokens to the shared theme file',
    costUsd: 0.22, contextUsedPercent: 8, rateLimits: null,
    updatedAgoMs: 3 * DAY,
  },
  {
    name: 'data-pipeline', sessionId: 'a3904204-82c2-40d0-b81d-313ecfe485bd',
    cwd: '/home/dev/work/data-pipeline', gitBranch: 'main', kind: 'interactive',
    live: false,
    preview: 'Backfill the nightly aggregation job for the last two weeks',
    costUsd: 0.91, contextUsedPercent: 80,
    rateLimits: { five_hour: 6, seven_day: 14 }, rateLimitsAgoMs: 4 * WEEK,
    // Just inside the default 30-day cleanupPeriodDays window, so the
    // expiry badge (<=5 days left) fires — this is the one session meant
    // to show "expires in 1d".
    updatedAgoMs: 29.2 * DAY,
  },
];

function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function seed(outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const liveAgentEntries = [];

  for (const s of SESSIONS) {
    const updatedAt = new Date(NOW - s.updatedAgoMs);

    // projects/<encoded-cwd>/<sessionId>.jsonl — the transcript
    // discoverSessions.mjs walks directly. First line carries cwd/gitBranch
    // (readHeadFields scans from the start); the user line is what
    // transcriptPreview.mjs's backward scan surfaces as the row's preview;
    // agent-name is what supplies session.name for a session with no (or a
    // since-deleted) sessions/*.json registry pointer.
    const transcriptPath = path.join(
      outDir, 'projects', encodeCwdForProjectDir(s.cwd), `${s.sessionId}.jsonl`
    );
    writeJsonl(transcriptPath, [
      { type: 'system', subtype: 'init', cwd: s.cwd, gitBranch: s.gitBranch, sessionId: s.sessionId },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: s.preview }] } },
      { type: 'agent-name', agentName: s.name },
    ]);
    fs.utimesSync(transcriptPath, updatedAt, updatedAt);

    // activity/<sessionId>.json — the statusline sidecar. Drives the
    // cost/context/rate-limit numbers directly; present for every seeded
    // session so the demo shows a fully populated dashboard.
    const rateLimitsAt = s.rateLimitsAgoMs != null ? Math.floor((NOW - s.rateLimitsAgoMs) / 1000) : Math.floor(NOW / 1000);
    fs.mkdirSync(path.join(outDir, 'activity'), { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'activity', `${s.sessionId}.json`),
      JSON.stringify({
        session_id: s.sessionId,
        session_name: s.name,
        model: 'claude-sonnet-5',
        cwd: s.cwd,
        git_branch: s.gitBranch,
        updated_at: rateLimitsAt,
        context_window: { used_percentage: s.contextUsedPercent, context_window_size: 1_000_000 },
        rate_limits: s.rateLimits
          ? {
            five_hour: { used_percentage: s.rateLimits.five_hour, resets_at: null },
            seven_day: { used_percentage: s.rateLimits.seven_day, resets_at: null },
          }
          : null,
        cost: { total_cost_usd: s.costUsd, total_duration_ms: null },
      })
    );

    // sessions/<pid>.json — only for the still-"running" sessions. A clean
    // exit deletes this pointer (see discoverSessions.mjs's own comment),
    // so the 5 resumable/dead sessions here correctly have none; their name
    // comes from the transcript's agent-name line instead.
    if (s.live) {
      fs.mkdirSync(path.join(outDir, 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'sessions', `${LIVE_PID}-${s.sessionId.slice(0, 8)}.json`),
        JSON.stringify({
          name: s.name, sessionId: s.sessionId, cwd: s.cwd, pid: LIVE_PID,
          kind: s.kind, status: s.status, updatedAt: updatedAt.getTime(),
        })
      );

      liveAgentEntries.push({
        sessionId: s.sessionId, kind: s.kind, cwd: s.cwd, status: s.status,
        pid: LIVE_PID, id: s.jobId ?? null, startedAt: updatedAt.getTime(),
      });
    }
  }

  // settings.json — same file Claude Code itself writes cleanupPeriodDays
  // into (see lib/config.mjs).
  fs.writeFileSync(path.join(outDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));

  // See the module comment above: not read by the app, just a shared source
  // of truth for a `claude agents --json --all` PATH shim to print verbatim.
  fs.writeFileSync(path.join(outDir, 'live-agents.demo.json'), JSON.stringify(liveAgentEntries));

  return outDir;
}

const outDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-demo-'));
seed(outDir);
console.log(outDir);
