# Query Windows session + lock state. Reports the WTS connect state, the physical console
# session id, and whether the user is "locked" via the registry/session flags.
# Run UNLOCKED and LOCKED, compare.
#
#   powershell -ExecutionPolicy Bypass -File sessionState.ps1
#
# Connect states of interest:
#   Active       = console unlocked, user present
#   WTSDisconnected / absent console = possibly locked or RDP-disconnected
# Also reads: --lock-state-ish heuristics via GetUserName+explorer, and LogonPid.

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WTS {
    [DllImport("wtsapi32.dll", SetLastError=true)]
    public static extern bool WTSEnumerateSessions(IntPtr hServer, int Reserved, int Version, out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll", SetLastError=true)]
    public static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int WTSInfoClass, out IntPtr ppBuffer, out int pBytesReturned);

    [StructLayout(LayoutKind.Sequential)]
    public struct WTS_SESSION_INFO {
        public int SessionId;
        public IntPtr WinStation;
        public int State;
    }

    public const int WTSActive = 0;
    public const int WTSConnected = 1;
    public const int WTSDisconnected = 4;
    public static string StateName(int s) => s switch {
        0 => "Active",
        1 => "Connected",
        2 => "ConnectQuery",
        3 => "Shadow",
        4 => "Disconnected",
        5 => "Idle",
        6 => "Listen",
        7 => "Reset",
        8 => "Down",
        _ => "Unknown("+s+")",
    };
}
'@
Add-Type -TypeDefinition $code

Write-Host "=== Session State ==="
Write-Host "(also try built-in:  qwinsta / qwinsta.exe)"
Write-Host ""

# Physical console session id
$cs = (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId
Write-Host "explorer SessionId (console proxy): $cs"

# Lockfile-style heuristic: if LogonUI.exe is running on the active console session,
# the machine is showing the lock/logon screen.
$logonui = Get-Process LogonUI -ErrorAction SilentlyContinue
if ($logonui) {
    Write-Host "LogonUI.exe running (SessionId=$($logonui.SessionId)) => LOCKED / logon screen"
} else {
    Write-Host "LogonUI.exe NOT running => UNLOCKED"
}

Write-Host ""
Write-Host "=== WTS Enumerate Sessions ==="
$count = 0
$ptr = [IntPtr]::Zero
if ([WTS]::WTSEnumerateSessions([IntPtr]::Zero, 0, 1, [ref]$ptr, [ref]$count)) {
    $size = [Runtime.InteropServices.Marshal]::SizeOf([type][WTS+WTS_SESSION_INFO])
    for ($i = 0; $i -lt $count; $i++) {
        $offset = [int64]$ptr + ($i * $size)
        $si = [Runtime.InteropServices.Marshal]::PtrToStructure([IntPtr]$offset, [type][WTS+WTS_SESSION_INFO])
        $station = [Runtime.InteropServices.Marshal]::PtrToStringUni($si.WinStation)
        Write-Host ("  SessionId={0,-3} State={1,-14} WinStation={2}" -f $si.SessionId, [WTS]::StateName($si.State), $station)
    }
    [WTS]::WTSFreeMemory($ptr)
} else {
    Write-Host "WTSEnumerateSessions failed."
}
