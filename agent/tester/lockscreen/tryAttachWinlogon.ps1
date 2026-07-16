# Try the RustDesk trick: open the Winlogon input desktop, SetThreadDesktop onto it,
# and attempt a .NET Graphics capture (BitBlt) from there. If we get non-black pixels
# while LOCKED, this is the path forward (run agent as SYSTEM + attach).
#
#   powershell -ExecutionPolicy Bypass -File tryAttachWinlogon.ps1
#
# IMPORTANT:
#   - SetThreadDesktop only works if the thread has NO existing hooks/windows/binds.
#     We spawn a fresh thread via a new Runspace to maximize the chance.
#   - OpenInputDesktop('Winlogon') while LOCKED needs read+enum access; as the logged-in
#     user this usually works for Default but may be DENIED for Winlogon (Winlogon is
#     owned by SYSTEM). If access is denied, that itself is a finding: agent must run
#     as SYSTEM (service) to attach — that's what RustDesk/TeamViewer do.
#   - If NOT currently locked, Input desktop = "Default" and this just captures normal
#     screen; run twice (unlocked + locked) to compare.

param([string]$OutFile = "winlogon-capture.png")

$code = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public static class WinCap {
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, System.Text.StringBuilder pvInfo, uint cchInfo, out uint lpcchInfo);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int x1, int y1, uint rop);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr ho);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public const int UOI_NAME = 2;
    public const uint DESKTOP_READOBJECTS = 0x0001;
    public const uint DESKTOP_ENUMERATE    = 0x0040;
    public const uint GENERIC_ALL          = 0x10000000;
    public const uint SRCCOPY = 0x00CC0020;

    public static string Name(IntPtr h) {
        var sb = new System.Text.StringBuilder(256); uint len;
        return GetUserObjectInformation(h, UOI_NAME, sb, (uint)sb.Capacity, out len) ? sb.ToString() : "?";
    }

    // Returns: (status, name, w, h, avgByte, err)
    public static string Capture(string savePath) {
        uint acc = GENERIC_ALL; // try full access first
        IntPtr hDesk = OpenInputDesktop(0, false, acc);
        int err = Marshal.GetLastWin32Error();
        if (hDesk == IntPtr.Zero) {
            acc = DESKTOP_READOBJECTS | DESKTOP_ENUMERATE;
            hDesk = OpenInputDesktop(0, false, acc);
            err = Marshal.GetLastWin32Error();
        }
        if (hDesk == IntPtr.Zero) return "OpenInputDesktop FAILED err=0x" + err.ToString("X") + " (likely need SYSTEM to open Winlogon)";
        string dname = Name(hDesk);
        string pre = "thread-before=" + Name(GetThreadDesktop(GetCurrentThreadId()));
        bool ok = false;
        // GENERIC_ALL (which includes DESKTOP_SETSOMEOBJECT) is required for SetThreadDesktop.
        // If we only got READ, SetThreadDesktop will fail — report it.
        bool setOk = (acc == GENERIC_ALL) && SetThreadDesktop(hDesk);
        int setErr = Marshal.GetLastWin32Error();
        string setMsg = setOk ? "SetThreadDesktop=ok" : ("SetThreadDesktop=FAIL err=0x" + setErr.ToString("X") + " (needs GENERIC_ALL / SYSTEM)");

        long sum = 0; long samples = 0; int W = 0, H = 0;
        try {
            IntPtr hwnd = GetDesktopWindow();
            RECT r; GetWindowRect(hwnd, out r);
            W = r.Right - r.Left; H = r.Bottom - r.Top;
            IntPtr hdcSrc = GetDC(IntPtr.Zero);
            IntPtr hdcMem = CreateCompatibleDC(hdcSrc);
            IntPtr hBmp = CreateCompatibleBitmap(hdcSrc, W, H);
            IntPtr old = SelectObject(hdcMem, hBmp);
            BitBlt(hdcMem, 0, 0, W, H, hdcSrc, 0, 0, SRCCOPY);
            // sample
            using (var bmp = Image.FromHbitmap(hBmp)) {
                bmp.Save(savePath, ImageFormat.Png);
                using (var tmp = new Bitmap(bmp)) {
                    for (int y = 0; y < tmp.Height; y += 31)
                        for (int x = 0; x < tmp.Width; x += 31) {
                            Color c = tmp.GetPixel(x, y);
                            sum += (c.R + c.G + c.B) / 3; samples++;
                        }
                }
            }
            SelectObject(hdcMem, old);
            DeleteObject(hBmp); DeleteDC(hdcMem); ReleaseDC(IntPtr.Zero, hdcSrc);
            ok = true;
        } catch (Exception e) {
            return dname + " | " + pre + " | " + setMsg + " | CAPTURE EXCEPTION: " + e.Message;
        }
        double avg = samples > 0 ? (double)sum / samples : -1;
        return "desktop=" + dname + " | " + pre + " | " + setMsg + " | " + (ok ? ("saved " + W + "x" + H + " avgByte=" + avg.ToString("F1")) : "no capture");
    }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing,System.Drawing.Common 2>$null
Add-Type -AssemblyName System.Drawing

$full = Join-Path $PSScriptRoot $OutFile
$res = [WinCap]::Capture($full)
Write-Host "=== tryAttachWinlogon ==="
Write-Host "Result: $res"
Write-Host "Saved to: $full"
Write-Host ""
Write-Host "Interpretation:"
Write-Host " - If 'desktop=Winlogon' and avgByte > 8  => you CAN capture the lock screen via SetThreadDesktop. Next step: run agent as SYSTEM."
Write-Host " - If 'OpenInputDesktop FAILED' or 'SetThreadDesktop=FAIL' => need SYSTEM (service) to attach. Lock screen capture requires service."
Write-Host " - If 'desktop=Default'  => machine was NOT locked when you ran this. Lock it (Win+L) and run again."
