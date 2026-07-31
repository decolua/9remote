// Desktop elevate launcher (run as admin via UAC). Spawns desktop-bridge.exe as
// Local System inside the console session so it can SendInput into the Winlogon
// (login) desktop. Worker path defaults to the launcher's own directory.
//   csc -nologo -target:winexe -out:desktop-elevate.exe desktop-elevate.cs
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

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
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUserW(IntPtr h, string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr h, int cls, ref uint val, int len);
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
  const int TokenSessionId = 12;

  // Launcher failures are otherwise silent (every error path just returns), and
  // the only symptom downstream is "no worker". Log beside the exe like the worker.
  static string LOG = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.log");
  static void L(string m) {
    try { File.AppendAllText(LOG, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + m + "\n"); } catch {}
  }

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

  // Highest desktop-bridge-<n>.exe in dir, or null. Numeric compare — a string
  // sort would rank "9" above "10" and pin the worker to an old build forever.
  static string PickNewestWorker(string dir) {
    string best = null;
    int bestV = -1;
    try {
      foreach (var f in Directory.GetFiles(dir, "desktop-bridge-*.exe")) {
        var name = Path.GetFileNameWithoutExtension(f);
        int v;
        if (!int.TryParse(name.Substring("desktop-bridge-".Length), out v)) continue;
        if (v > bestV) { bestV = v; best = f; }
      }
    } catch { return null; }
    return best;
  }

  static void Main() {
    uint sid = 0xFFFFFFFF;
    L("start pid=" + Process.GetCurrentProcess().Id + " session=" + Process.GetCurrentProcess().SessionId);

    IntPtr hSelf;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out hSelf)) {
      EnablePriv(hSelf, "SeImpersonatePrivilege");
      EnablePriv(hSelf, "SeAssignPrimaryTokenPrivilege");
      EnablePriv(hSelf, "SeIncreaseQuotaPrivilege");
      // Required to rewrite a token's session id (see the SetTokenInformation below).
      EnablePriv(hSelf, "SeTcbPrivilege");
      CloseHandle(hSelf);
    }

    // At boot this launcher runs before the console session finishes coming up:
    // WTSGetActiveConsoleSessionId can return 0xFFFFFFFF (no session attached)
    // and winlogon.exe for that session may not exist yet. Poll for up to 2min
    // instead of exiting — a one-shot check would leave the worker dead until
    // the next reboot, which is the very failure this task exists to prevent.
    int wpid = -1;
    for (int attempt = 0; attempt < 120 && wpid < 0; attempt++) {
      sid = WTSGetActiveConsoleSessionId();
      if (sid != 0xFFFFFFFF) {
        foreach (var p in Process.GetProcesses()) {
          if (p.ProcessName.Equals("winlogon", StringComparison.OrdinalIgnoreCase) && p.SessionId == sid) { wpid = p.Id; break; }
        }
      }
      if (wpid < 0) Thread.Sleep(1000);
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

    // Worker lives beside this launcher exe, named desktop-bridge-<version>.exe.
    // Version-stamped so the agent can build a new one without overwriting (and
    // locking) the copy currently running — this boot then picks up the newest.
    string app = PickNewestWorker(AppDomain.CurrentDomain.BaseDirectory);
    if (app == null) { DestroyEnvironmentBlock(env); CloseHandle(dup); CloseHandle(ht); CloseHandle(hp); return; }

    var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
    si.lpDesktop = @"winsta0\default";

    // Pin the token to the console session. The duplicated winlogon token already
    // carries it, but this is the one thing that must not be wrong — a worker in
    // the wrong session still starts, still answers the pipe, and SendInput still
    // reports success, while every keystroke lands on session 0's Winlogon desktop
    // instead of the screen the user is looking at. Needs SeTcbPrivilege.
    if (!SetTokenInformation(dup, TokenSessionId, ref sid, sizeof(uint)))
      L("SetTokenInformation(session=" + sid + ") failed winerr=" + Marshal.GetLastWin32Error());

    // CreateProcessAsUserW, not CreateProcessWithTokenW: the latter routes through
    // the Secondary Logon service, which places the child in the CALLER's session
    // and ignores the token's. That was invisible while the launcher was started by
    // UAC from the console session — under the AtStartup task the launcher runs in
    // session 0, and the worker went with it. CreateProcessAsUserW honours the
    // token's session; SYSTEM already holds the required SeAssignPrimaryTokenPrivilege.
    PROCESS_INFORMATION pi;
    bool ok = CreateProcessAsUserW(dup, app, "\"" + app + "\"", IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, env, AppDomain.CurrentDomain.BaseDirectory, ref si, out pi);
    if (!ok) {
      L("CreateProcessAsUserW failed winerr=" + Marshal.GetLastWin32Error() + " — falling back to CreateProcessWithTokenW");
      ok = CreateProcessWithTokenW(dup, 0, app, "\"" + app + "\"", CREATE_UNICODE_ENVIRONMENT, env, AppDomain.CurrentDomain.BaseDirectory, ref si, out pi);
    }
    L((ok ? "spawned " : "spawn FAILED ") + app + " session=" + sid + (ok ? " pid=" + pi.dwProcessId : " winerr=" + Marshal.GetLastWin32Error()));

    DestroyEnvironmentBlock(env);
    if (ok) { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); }
    CloseHandle(dup); CloseHandle(ht); CloseHandle(hp);
  }
}
