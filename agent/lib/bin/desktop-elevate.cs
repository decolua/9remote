// Desktop elevate launcher (run as admin via UAC). Spawns desktop-bridge.exe as
// Local System inside the console session so it can SendInput into the Winlogon
// (login) desktop. Worker path defaults to the launcher's own directory.
//   csc -nologo -target:winexe -out:desktop-elevate.exe desktop-elevate.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class DesktopElevate {
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint da, bool inh, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint da, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr ex, uint da, IntPtr sa, int imp, int t, out IntPtr dup);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValueW(string sys, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr h, bool dis, ref TOKEN_PRIVILEGES np, int len, IntPtr p, IntPtr l);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithTokenW(IntPtr h, uint logonFlags, string app, string cmd, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr hToken, bool inherit);
  [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);

  const uint TOKEN_QUERY = 0x0008;
  const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
  const uint TOKEN_DUPLICATE = 0x0002;
  const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const int SecurityImpersonation = 2;
  const int TokenPrimary = 1;
  const uint SE_PRIVILEGE_ENABLED = 0x00000002;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

  [StructLayout(LayoutKind.Sequential)]
  struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)]
  struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privileges; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  static void EnablePriv(IntPtr h, string n) {
    LUID l;
    if (!LookupPrivilegeValueW(null, n, out l)) return;
    TOKEN_PRIVILEGES tp;
    tp.PrivilegeCount = 1;
    tp.Privileges.Luid = l;
    tp.Privileges.Attributes = SE_PRIVILEGE_ENABLED;
    AdjustTokenPrivileges(h, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
  }

  static void Main() {
    uint sid = WTSGetActiveConsoleSessionId();

    IntPtr hSelf;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out hSelf)) {
      EnablePriv(hSelf, "SeImpersonatePrivilege");
      EnablePriv(hSelf, "SeAssignPrimaryTokenPrivilege");
      EnablePriv(hSelf, "SeIncreaseQuotaPrivilege");
      CloseHandle(hSelf);
    }

    int wpid = -1;
    foreach (var p in Process.GetProcesses()) {
      if (p.ProcessName.Equals("winlogon", StringComparison.OrdinalIgnoreCase) && p.SessionId == sid) { wpid = p.Id; break; }
    }
    if (wpid < 0) return;

    IntPtr hp = OpenProcess(PROCESS_QUERY_INFORMATION, false, wpid);
    if (hp == IntPtr.Zero) return;

    IntPtr ht;
    if (!OpenProcessToken(hp, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, out ht)) { CloseHandle(hp); return; }

    IntPtr dup;
    if (!DuplicateTokenEx(ht, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup)) { CloseHandle(ht); CloseHandle(hp); return; }

    IntPtr env;
    if (!CreateEnvironmentBlock(out env, dup, false)) { CloseHandle(dup); CloseHandle(ht); CloseHandle(hp); return; }

    // Worker lives beside this launcher exe.
    string app = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "desktop-bridge.exe");
    if (!File.Exists(app)) { DestroyEnvironmentBlock(env); CloseHandle(dup); CloseHandle(ht); CloseHandle(hp); return; }

    var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
    si.lpDesktop = @"winsta0\default";

    // CreateProcessWithTokenW: the launcher itself runs elevated in the console
    // session (spawned via Start-Process -Verb RunAs from the agent), so the
    // worker inherits the console session and SendInput reaches the user's
    // Winlogon desktop. Same pattern as .docs/login/launcher.cs.
    PROCESS_INFORMATION pi;
    bool ok = CreateProcessWithTokenW(dup, 0, app, "\"" + app + "\"", CREATE_UNICODE_ENVIRONMENT, env, AppDomain.CurrentDomain.BaseDirectory, ref si, out pi);

    DestroyEnvironmentBlock(env);
    if (ok) { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
    CloseHandle(dup); CloseHandle(ht); CloseHandle(hp);
  }
}
