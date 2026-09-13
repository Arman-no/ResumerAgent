<#
.SYNOPSIS
Resets a console's VT/xterm modes that a killed interactive session may
have left enabled — mouse-tracking reporting AND raw VT key translation.

.DESCRIPTION
A live interactive Claude Code session enables mouse tracking (an xterm
private mode, toggled via output-stream escape sequences) and also turns
on ENABLE_VIRTUAL_TERMINAL_INPUT (a classic Win32 console INPUT mode
flag, toggled via SetConsoleMode — a different layer entirely) so it can
read arrow keys, function keys, and mouse events as raw escape bytes
instead of classic Windows key events. Both are owned by the console
itself, not the process that set them.

First fix attempt (output-stream mouse-tracking disables only) was
INSUFFICIENT — confirmed live 2026-09-13 via direct user report: typed
characters + Enter were clean, but arrow keys and mouse movement still
produced garbage. Root-caused by checking GetConsoleMode on a real
affected console after a real Close: input mode read 0x20F —
ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) was still set. Windows' own
auto-recovery of the classic input flags (confirmed to happen in an
earlier test) is NOT reliable enough to depend on here — it left a
different, still-broken partial state this time (missing mouse-input,
insert-mode, quick-edit too). Fixed by explicitly forcing the input mode
via SetConsoleMode rather than hoping for auto-recovery, in addition to
the output-stream mouse-tracking disables (still needed — they're a
separate layer SetConsoleMode's INPUT-side flags don't touch).

Runs against the PARENT's console (the pid this script is given must be
the surviving parent, e.g. cmd.exe — the target session's own pid is
already dead by the time this runs).
#>
param(
  [Parameter(Mandatory = $true)]
  [int]$ParentPid
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ResumerAgentConsoleReset {
  public class Native {
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
  }
}
'@

[ResumerAgentConsoleReset.Native]::FreeConsole() | Out-Null
$attached = [ResumerAgentConsoleReset.Native]::AttachConsole([uint32]$ParentPid)
if (-not $attached) {
  Write-Error "reset-terminal-modes: could not attach to console of pid $ParentPid"
  exit 1
}

try {
  $STD_OUTPUT_HANDLE = -11
  $hOut = [ResumerAgentConsoleReset.Native]::GetStdHandle($STD_OUTPUT_HANDLE)

  # 1000/1002/1003: basic / button-event / any-event mouse click tracking.
  # 1006/1015: SGR / urxvt extended-coordinate encodings (either can be
  # active depending on what the app negotiated). 2004: bracketed paste.
  # 1049: alternate screen buffer, in case the TUI's full-screen view
  # never got to switch back. 25h: make sure the cursor is visible again.
  # Final `ESC c` is RIS (Reset to Initial State) — the standard terminal
  # reset, a catch-all for anything not explicitly listed above.
  $ESC = [char]27
  $seq = "$ESC[?1000l$ESC[?1002l$ESC[?1003l$ESC[?1006l$ESC[?1015l$ESC[?2004l$ESC[?1049l$ESC[?25h${ESC}c"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($seq)
  [uint32]$written = 0
  [ResumerAgentConsoleReset.Native]::WriteFile($hOut, $bytes, [uint32]$bytes.Length, [ref]$written, [IntPtr]::Zero) | Out-Null

  # The output-stream sequences above are a separate layer from this: they
  # toggle xterm private modes, not the classic Win32 INPUT mode flags
  # that control whether arrow/function keys and mouse events arrive as
  # raw VT escape bytes (ENABLE_VIRTUAL_TERMINAL_INPUT, 0x0200) or as
  # normal Windows key events a cmd.exe prompt actually understands.
  # Force it to the known-good baseline rather than trust Windows'
  # own recovery, which was directly observed to leave a still-broken
  # partial state (0x20F: VT input still on, several normal flags
  # missing) rather than a clean one.
  $STD_INPUT_HANDLE = -10
  $hIn = [ResumerAgentConsoleReset.Native]::GetStdHandle($STD_INPUT_HANDLE)
  $ENABLE_PROCESSED_INPUT = 0x0001
  $ENABLE_LINE_INPUT = 0x0002
  $ENABLE_ECHO_INPUT = 0x0004
  $ENABLE_MOUSE_INPUT = 0x0010
  $ENABLE_INSERT_MODE = 0x0020
  $ENABLE_QUICK_EDIT_MODE = 0x0040
  $ENABLE_EXTENDED_FLAGS = 0x0080
  $ENABLE_AUTO_POSITION = 0x0100
  $normalInputMode = $ENABLE_PROCESSED_INPUT -bor $ENABLE_LINE_INPUT -bor $ENABLE_ECHO_INPUT `
    -bor $ENABLE_MOUSE_INPUT -bor $ENABLE_INSERT_MODE -bor $ENABLE_QUICK_EDIT_MODE `
    -bor $ENABLE_EXTENDED_FLAGS -bor $ENABLE_AUTO_POSITION
  [ResumerAgentConsoleReset.Native]::SetConsoleMode($hIn, $normalInputMode) | Out-Null
} finally {
  [ResumerAgentConsoleReset.Native]::FreeConsole() | Out-Null
}
