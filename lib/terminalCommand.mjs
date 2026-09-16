import { execFileSync } from 'node:child_process';

// `which` ships on every mainstream macOS/Linux install and Node's execFile
// already searches PATH on POSIX without needing shell:true — no reason to
// hand-roll a PATH walk for something the OS already answers correctly.
// Real callers use this default; tests always inject a fake isInstalled so
// the suite never depends on what's actually on the host running it.
function probeInstalled(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Standard POSIX single-quote wrap: close the quote, emit an escaped quote,
// reopen it. Safe for any byte a path/command can contain, no exceptions.
function shQuote(str) {
  return `'${String(str).replaceAll("'", `'\\''`)}'`;
}

// AppleScript string-literal quoting for osascript's -e argument — distinct
// from shell quoting because it's a different parser one layer in.
function asQuote(str) {
  return `"${String(str).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function applyOverride(template, { command, title, cwd }) {
  return template.replaceAll('{command}', command).replaceAll('{title}', title).replaceAll('{cwd}', cwd);
}

// Byte-for-byte the pre-cross-platform behaviour — see server.mjs's comment
// on why this exact quoting is the only thing that survives cmd.exe's
// nested `start` -> `cmd /k` parsing. cwd is deliberately not baked in here
// (spawn's own `cwd` option carries it instead), for the same reason.
function winDefault({ command, title }) {
  return `start "${title}" cmd /k "${command}"`;
}

// Terminal.app has no "run and cd first" flag, so the do-script payload is
// a plain shell command string: cd, then the resume command. Two extra
// osascript -e calls (not one big script) keeps each -e argument a single
// AppleScript statement, which is the form osascript expects.
function darwinDefault({ command, cwd }) {
  const shellCmd = `cd ${shQuote(cwd)} && ${command}`;
  const doScript = `tell application "Terminal" to do script ${asQuote(shellCmd)}`;
  const activate = `tell application "Terminal" to activate`;
  return `osascript -e ${shQuote(doScript)} -e ${shQuote(activate)}`;
}

// Every emulator here gets pointed at the same `bash -c "cd ... && command;
// exec bash"` payload rather than each one's own native cwd/exec flags —
// one code path to get right instead of seven, and `exec bash` is what
// keeps the window open after the command exits/errors, the same job
// `cmd /k` does on Windows. Flag names below are each emulator's real
// title/exec syntax; x-terminal-emulator is Debian's alternatives shim,
// documented to accept the same -T/-e xterm-compatible pair as xterm itself.
const LINUX_EMULATORS = [
  { name: 'x-terminal-emulator', build: (title, inner) => `x-terminal-emulator -T ${shQuote(title)} -e bash -c ${shQuote(inner)}` },
  // No title flag for these two on purpose: gnome-terminal deprecated
  // --title and konsole never had it (it wants -p tabtitle=). An unknown
  // flag makes the emulator exit instead of opening, which would break
  // Resume outright on GNOME/KDE — and the title is only cosmetic.
  { name: 'gnome-terminal', build: (title, inner) => `gnome-terminal -- bash -c ${shQuote(inner)}` },
  { name: 'konsole', build: (title, inner) => `konsole -e bash -c ${shQuote(inner)}` },
  { name: 'xfce4-terminal', build: (title, inner) => `xfce4-terminal --title=${shQuote(title)} -x bash -c ${shQuote(inner)}` },
  { name: 'alacritty', build: (title, inner) => `alacritty --title ${shQuote(title)} -e bash -c ${shQuote(inner)}` },
  { name: 'kitty', build: (title, inner) => `kitty --title ${shQuote(title)} bash -c ${shQuote(inner)}` },
  { name: 'xterm', build: (title, inner) => `xterm -T ${shQuote(title)} -e bash -c ${shQuote(inner)}` },
];

function linuxDefault({ command, title, cwd, isInstalled }) {
  const inner = `cd ${shQuote(cwd)} && ${command}; exec bash`;
  const emulator = LINUX_EMULATORS.find((entry) => isInstalled(entry.name));
  return emulator ? emulator.build(title, inner) : null;
}

// Pure by design: every OS call this needs (the PATH probe) comes in as
// `isInstalled`, so the same function that runs in production is exactly
// what the tests exercise — no mocking framework, no monkey-patching.
export function resolveTerminalCommand({ platform, command, title, cwd, override, isInstalled = probeInstalled }) {
  if (override) return applyOverride(override, { command, title, cwd });
  if (platform === 'win32') return winDefault({ command, title });
  if (platform === 'darwin') return darwinDefault({ command, cwd });
  return linuxDefault({ command, title, cwd, isInstalled });
}
