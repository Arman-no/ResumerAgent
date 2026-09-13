<#
.SYNOPSIS
Resets a console's VT/xterm modes that a killed interactive session may
have left enabled — specifically, mouse-tracking reporting.

.DESCRIPTION
A live interactive Claude Code session enables mouse tracking (and other
xterm private modes) for its own TUI. Those modes are owned by the
console itself, not the process that set them — Windows resets the
classic input-mode flags (echo, line input, processed input) on its own
once the child exits (confirmed live), but does NOT undo VT-level modes
like mouse reporting on its own. If the session that set them is force-
ended instead of exiting normally (which would send the matching
"disable" sequences itself), the surviving parent terminal keeps
reporting every mouse movement as raw escape-code text for as long as
it's open — real bug, reported 2026-09-13, confirmed reproducible via
lib/closeSession.mjs's own Close action.

Fixed by attaching to the PARENT's console (the pid this script is given
must be the surviving parent, e.g. cmd.exe — the target session's own pid
is already dead by the time this runs) and writing the standard "disable"
sequences directly to its output stream, exactly as if the session itself
had cleaned up on exit. Ends with a full VT reset (RIS, ESC c) as a
catch-all for anything not explicitly listed.
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
} finally {
  [ResumerAgentConsoleReset.Native]::FreeConsole() | Out-Null
}
