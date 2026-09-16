import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalCommand } from './terminalCommand.mjs';

// Every case pins `platform` and (where relevant) injects `isInstalled`
// explicitly, so the suite never depends on what's actually installed on
// whatever machine runs `node --test`.

const base = { command: 'claude --resume abc123', title: 'Claude: my-session', cwd: 'C:\\work\\proj' };

test('win32 default is byte-for-byte the pre-cross-platform start/cmd-k line', () => {
  const line = resolveTerminalCommand({ platform: 'win32', ...base });
  assert.equal(line, 'start "Claude: my-session" cmd /k "claude --resume abc123"');
});

test('darwin default drives Terminal.app via osascript, cd-ing to cwd first', () => {
  const line = resolveTerminalCommand({ platform: 'darwin', ...base, cwd: "/Users/me/my proj" });
  // The path's own single quote (from shQuote-ing it for the `cd`) gets
  // re-escaped by the outer shQuote wrapping the whole AppleScript -e
  // argument — that `'\''` is correct POSIX quoting, not a bug, so the
  // expectation is spelled out exactly rather than approximated.
  assert.equal(
    line,
    `osascript -e 'tell application "Terminal" to do script "cd '\\''/Users/me/my proj'\\'' && claude --resume abc123"' -e 'tell application "Terminal" to activate'`
  );
});

test('linux picks the first installed emulator in priority order', () => {
  // konsole and kitty are "installed"; gnome-terminal (earlier in priority)
  // is not — expect konsole to win, not kitty.
  const isInstalled = (name) => ['konsole', 'kitty'].includes(name);
  const line = resolveTerminalCommand({ platform: 'linux', ...base, isInstalled });
  assert.equal(
    line,
    `konsole -e bash -c 'cd '\\''C:\\work\\proj'\\'' && claude --resume abc123; exec bash'`
  );
});

test('linux with nothing installed returns null', () => {
  const line = resolveTerminalCommand({ platform: 'linux', ...base, isInstalled: () => false });
  assert.equal(line, null);
});

test('an override template wins over every platform default, on every platform', () => {
  const override = 'my-term --title {title} --cwd {cwd} -- {command}';
  for (const platform of ['win32', 'darwin', 'linux']) {
    const line = resolveTerminalCommand({ platform, ...base, override, isInstalled: () => false });
    assert.equal(line, 'my-term --title Claude: my-session --cwd C:\\work\\proj -- claude --resume abc123');
  }
});
