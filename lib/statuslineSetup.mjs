import os from 'node:os';
import path from 'node:path';

// Matched by filename substring, not by exact command equality — the
// command we build always embeds this filename (plain or wrapped behind
// `--chain`), so a substring check is the one check that survives both.
export const SIDECAR_FILENAME = 'statusline-sidecar.mjs';

// Same resolution Claude Code itself uses, and the same one
// scripts/statusline-sidecar.mjs falls back to when writing the sidecar —
// kept identical so setup always points at the directory the script will
// actually write into.
export function resolveConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// base64-of-UTF8: survives cmd.exe, PowerShell, Git Bash and POSIX sh
// unquoted as a single argument (no spaces, quotes, `&`, `|`, `$`, backtick,
// or any other shell metacharacter in the alphabet), unlike the original
// command string itself which may contain all of those.
export function encodeChain(originalCommand) {
  return Buffer.from(originalCommand, 'utf8').toString('base64');
}

export function decodeChain(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

// Last argument wins and base64 has no whitespace, so a plain token split
// is enough — no shell-quoting parser needed.
export function extractChain(command) {
  const match = typeof command === 'string' && command.match(/--chain\s+(\S+)/);
  if (!match) return null;
  try {
    return decodeChain(match[1]);
  } catch {
    return null;
  }
}

// Builds `"<node>" "<script>"` (both double-quoted — works unmodified in
// cmd, PowerShell and POSIX shells, including paths with spaces), appending
// `--chain <encoded>` when wrapping a pre-existing statusline command.
export function buildCommand({ scriptPath, execPath = process.execPath, chainCommand } = {}) {
  // Forward slashes read fine to Node on Windows and sidestep every
  // backslash-as-escape-character ambiguity cmd/PowerShell/sh disagree on.
  const normalizedScript = scriptPath.replace(/\\/g, '/');
  let command = `"${execPath}" "${normalizedScript}"`;
  if (chainCommand) command += ` --chain ${encodeChain(chainCommand)}`;
  return command;
}

// Classifies settings.statusLine into exactly the shapes setup-statusline.mjs
// has to act on. 'other-shape' covers anything that isn't a {type:"command"}
// object — a different type, or a bare string/array — which setup must
// leave untouched.
export function classifyStatusLine(settings) {
  const sl = settings?.statusLine;
  if (sl == null) return { kind: 'none' };
  if (typeof sl === 'object' && !Array.isArray(sl) && sl.type === 'command' && typeof sl.command === 'string') {
    return SIDECAR_FILENAME && sl.command.includes(SIDECAR_FILENAME)
      ? { kind: 'ours', command: sl.command }
      : { kind: 'other-command', command: sl.command };
  }
  return { kind: 'other-shape', value: sl };
}

// For the dashboard: "is the sidecar wired up right now".
export function isSidecarStatuslineConfigured(settings) {
  return classifyStatusLine(settings).kind === 'ours';
}

// Pure: settings in, settings out. Caller decides whether classify() even
// allows this (none / other-command only — never call for 'ours' or
// 'other-shape').
export function computeInstalledSettings(settings, command) {
  return { ...settings, statusLine: { type: 'command', command } };
}

// Pure inverse of install. Returns null when there is nothing of ours to
// remove (caller should only call this after classify() says 'ours').
// Restores the original command dict-for-dict when one was chained;
// otherwise drops the key entirely, matching "no statusLine" before install.
export function computeRemovedSettings(settings) {
  const info = classifyStatusLine(settings);
  if (info.kind !== 'ours') return null;
  const original = extractChain(info.command);
  const { statusLine, ...rest } = settings;
  if (original) {
    return { ...rest, statusLine: { type: 'command', command: original } };
  }
  return rest;
}
