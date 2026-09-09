// Environment variables that identify *this specific process's* place in
// a Claude Code session or background-job hierarchy — never something a
// spawned/exec'd `claude` invocation should inherit. Confirmed via two
// real incidents (see docs/2026-09-09-session-dashboard-design.md): a
// resumed session inheriting these showed the wrong name and disabled its
// own transcript, and this project's own liveness-check invocation
// (lib/liveAgents.mjs) was found inheriting the same ones unstripped
// during a code review, which could scope/filter its output under the
// identical ambient condition. Every other env var on this machine was
// audited by hand before finalizing this list, to avoid stripping
// anything load-bearing (AWS_PROFILE/AWS_REGION for the Bedrock backend,
// notably) — see the design doc for the full audit.
const IDENTITY_ENV_KEYS = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_JOB_DIR',
  'CLAUDE_PID',
];

export function envWithoutIdentity() {
  const env = { ...process.env };
  for (const key of IDENTITY_ENV_KEYS) delete env[key];
  return env;
}
