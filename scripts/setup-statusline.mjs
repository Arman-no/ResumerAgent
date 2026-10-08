#!/usr/bin/env node
// Wires scripts/statusline-sidecar.mjs into settings.json as the user's
// Claude Code statusLine, without clobbering a statusline they already
// have. See README.md "Activity panel" and AGENT_SETUP.md for the human-
// facing explanation; this file is the implementation.
//
// Usage: node scripts/setup-statusline.mjs [--remove|--status]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfigDir,
  buildCommand,
  classifyStatusLine,
  computeInstalledSettings,
  computeRemovedSettings,
} from '../lib/statuslineSetup.mjs';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline-sidecar.mjs');
const BACKUP_SUFFIX = '.bak-resumeragent';

function readSettingsRaw(settingsPath) {
  try {
    return fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return undefined; // missing file, treated as "{}" by every caller below
  }
}

function parseSettings(raw) {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// One-time backup of whatever was on disk (or "{}" if nothing was), taken
// right before the first write this tool ever makes to this settings.json.
// Never overwritten on later runs, so it always holds the pre-ResumerAgent
// state even after install -> remove -> install again.
function backupOnce(settingsPath, rawBefore) {
  const backupPath = settingsPath + BACKUP_SUFFIX;
  if (fs.existsSync(backupPath)) return backupPath;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, rawBefore ?? '{}\n');
  return backupPath;
}

function writeSettings(settingsPath, rawBefore, newSettings) {
  const backupPath = backupOnce(settingsPath, rawBefore);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2) + '\n');
  return backupPath;
}

function describeShape(value) {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return `an object of type ${JSON.stringify(value.type ?? '(none)')}`;
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

function install(settingsPath, raw, settings) {
  const info = classifyStatusLine(settings);

  if (info.kind === 'ours') {
    console.log(`Already configured — statusLine in ${settingsPath} already runs statusline-sidecar.mjs. No change made.`);
    return;
  }

  if (info.kind === 'other-shape') {
    console.log(
      `Found a statusLine in ${settingsPath} that isn't a {"type":"command"} entry (${describeShape(info.value)}).\n` +
      `Not touching it. To add the sidecar anyway, edit settings.json by hand and wrap your statusLine command with:\n` +
      `  --chain <base64 of your current statusLine config>\n` +
      `or just run this script again after converting it to a {"type":"command"} entry yourself.`
    );
    return;
  }

  const chainCommand = info.kind === 'other-command' ? info.command : undefined;
  const command = buildCommand({ scriptPath: SCRIPT_PATH, chainCommand });
  const newSettings = computeInstalledSettings(settings, command);
  const backupPath = writeSettings(settingsPath, raw, newSettings);

  if (chainCommand) {
    console.log(`Wrapped your existing statusline so both still run.`);
    console.log(`  previous command: ${chainCommand}`);
  } else {
    console.log(`Installed the ResumerAgent statusline sidecar.`);
  }
  console.log(`  settings file:    ${settingsPath}`);
  console.log(`  backup of before: ${backupPath}`);
  console.log(`  new command:      ${command}`);
  console.log('Claude Code picks this up live on your next message — no restart needed.');
  console.log('Undo with: node scripts/setup-statusline.mjs --remove');
}

function remove(settingsPath, raw, settings) {
  const info = classifyStatusLine(settings);

  if (info.kind !== 'ours') {
    console.log(
      info.kind === 'none'
        ? `Nothing to remove — ${settingsPath} has no statusLine configured.`
        : `Nothing to remove — the statusLine in ${settingsPath} wasn't set up by this script (${describeShape(info.kind === 'other-command' ? { type: 'command' } : info.value)}).`
    );
    return;
  }

  const original = computeRemovedSettings(settings);
  const backupPath = writeSettings(settingsPath, raw, original);

  if (original.statusLine) {
    console.log(`Removed the sidecar and restored your original statusline.`);
    console.log(`  restored command: ${original.statusLine.command}`);
  } else {
    console.log(`Removed the sidecar. There was no statusline before it, so the key was deleted.`);
  }
  console.log(`  settings file:     ${settingsPath}`);
  console.log(`  backup of before:  ${backupPath}`);
}

function status(settingsPath, settings) {
  const info = classifyStatusLine(settings);
  switch (info.kind) {
    case 'ours': {
      const chained = extractChainNote(info.command);
      console.log(`Configured — ${settingsPath} runs statusline-sidecar.mjs${chained}.`);
      break;
    }
    case 'none':
      console.log(`Not configured — ${settingsPath} has no statusLine. Run: node scripts/setup-statusline.mjs`);
      break;
    case 'other-command':
      console.log(`Not configured — ${settingsPath} has a different statusLine command (not ours):\n  ${info.command}`);
      break;
    case 'other-shape':
      console.log(`Not configured — ${settingsPath} has a statusLine that isn't a plain command (${describeShape(info.value)}).`);
      break;
  }
}

function extractChainNote(command) {
  return command.includes('--chain') ? ' (wrapping an existing statusline)' : '';
}

function main() {
  const args = process.argv.slice(2);
  const configDir = resolveConfigDir(process.env);
  const settingsPath = path.join(configDir, 'settings.json');

  const raw = readSettingsRaw(settingsPath);
  const settings = parseSettings(raw);

  if (args.includes('--status')) return status(settingsPath, settings);
  if (args.includes('--remove')) return remove(settingsPath, raw, settings);
  return install(settingsPath, raw, settings);
}

main();
