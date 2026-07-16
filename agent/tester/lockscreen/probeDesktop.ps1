# Probe which Desktop the calling thread is attached to, the current Input Desktop,
# and enumerate all desktops under WinSta0. Run once UNLOCKED and once LOCKED (via SSH /
# scheduled task running as the user) and compare.
#
#   powershell -ExecutionPolicy Bypass -File probeDesktop.ps1
#
# When LOCKED you expect to see:
#   - InputDesktop name   = "Winlogon"  (when unlocked it is "Default")
#   - GetThreadDesktop    = different handle from InputDesktop (thread is NOT on Winlogon)
# That mismatch is exactly why DXGI capture goes black when locked.

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinDesktop {
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, [Out] StringBuilder pvInfo, uint cchInfo, out uint lpcchInfo);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EnumDesktopsW(IntPtr hwinsta, EnumDesktopsDelegate lpEnumFunc, IntPtr lParam);

    public delegate bool EnumDesktopsDelegate(string lpszDesktop, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetProcessWindowStation();

    public const int UOI_NAME = 2;
    public const uint DESKTOP_READOBJECTS = 0x0001;
    public const uint DESKTOP_ENUMERATE    = 0x0040;

    public static string DesktopName(IntPtr hDesk) {
        var sb = new StringBuilder(256);
        uint len;
        if (GetUserObjectInformation(hDesk, UOI_NAME, sb, (uint)sb.Capacity, out len)) {
            return sb.ToString();
        }
        return "<unknown>";
    }
}
'@
Add-Type -TypeDefinition $code

function Get-InputDesktopName {
    $h = [WinDesktop]::OpenInputDesktop(0, $false, [WinDesktop]::DESKTOP_READOBJECTS -bor [WinDesktop]::DESKTOP_ENUMERATE)
    if ($h -eq [IntPtr]::Zero) { return "<OpenInputDesktop failed: 0x$([Runtime.InteropServices.Marshal]::GetLastWin32Error().ToString('X'))>" }
    try { return [WinDesktop]::DesktopName($h) } finally { [void][WinDesktop]::CloseDesktop($h) }
}

$threadDesk  = [WinDesktop]::GetThreadDesktop([WinDesktop]::GetCurrentThreadId())
$inputDesk   = Get-InputDesktopName
$threadName  = [WinDesktop]::DesktopName($threadDesk)
$procWks     = [WinDesktop]::GetProcessWindowStation()

Write-Host "=== Desktop Probe ==="
Write-Host "ProcessWindowStation handle : $procWks"
Write-Host "Thread desktop handle       : $threadDesk  (name: $threadName)"
Write-Host "Input desktop (current)     : $inputDesk"
Write-Host "Thread on Input desktop?    : $($threadName -eq $inputDesk)"
Write-Host ""
Write-Host "=== Desktops under this WindowStation ==="

$names = New-Object System.Collections.ArrayList
$enum = [WinDesktop+EnumDesktopsDelegate]{
    param($name, $lparam)
    [void]$names.Add($name)
    return $true
}
[void][WinDesktop]::EnumDesktopsW($procWks, $enum, [IntPtr]::Zero)
$names | ForEach-Object { Write-Host "  - $_" }

Write-Host ""
Write-Host "Verdict:"
if ($inputDesk -eq 'Winlogon') {
    Write-Host "  Machine looks LOCKED (Input desktop = Winlogon)."
    Write-Host "  To capture it, agent must SetThreadDesktop(OpenInputDesktop('Winlogon')). See tryAttachWinlogon.ps1"
} elseif ($inputDesk -eq 'Default') {
    Write-Host "  Machine looks UNLOCKED (Input desktop = Default)."
} else {
    Write-Host "  Unexpected input desktop: $inputDesk"
}
