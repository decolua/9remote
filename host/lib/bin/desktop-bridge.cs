// Desktop bridge daemon (runs as Local System). Named pipe server "9remote-desktop".
// Protocol (line-based ASCII):
//   STATE          -> "DESKTOP <name>"  (name == "Winlogon" when on the login screen)
//   TYPE <text>    -> clears the field, types text via SendInput + VkKeyScanW, Enter; replies "OK"
//   csc -nologo -target:winexe -out:desktop-bridge.exe desktop-bridge.cs
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

class DesktopBridge {
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint f, bool inh, uint da);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr o, int i, IntPtr p, uint len, out uint need);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char c);

  // GENERIC_ALL required — GENERIC_READ silently drops keystrokes into Winlogon desktop.
  const uint GENERIC_ALL = 0x10000000;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const int UOI_NAME = 2;
  const ushort VK_BACK = 0x08;
  const ushort VK_RETURN = 0x0D;
  const ushort VK_SHIFT = 0x10;
  const string PIPE = "9remote-desktop";
  // Bump on every change to this file. The agent reads the same constant out of
  // the shipped .cs and compares it against what the running worker reports, so
  // a stale worker is detected without relying on file mtimes. Same contract as
  // DAEMON_VERSION for the pty daemon.
  const string VERSION = "2";
  // Global\ (not Local\): the boot task runs in session 0 while a user-triggered
  // launcher runs in the console session — a per-session mutex would not see across them.
  const string MUTEX_NAME = "Global\\9remote-desktop-bridge";
  // How long a starting worker waits for a shutting-down one to release the lock.
  const int HANDOFF_WAIT_MS = 10000;

  // Static so the GC never collects it while Main loops forever.
  static Mutex _instanceLock;

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct MKH {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public MKH u; }

  static string NameOf(IntPtr h) {
    uint need;
    GetUserObjectInformationW(h, UOI_NAME, IntPtr.Zero, 0, out need);
    if (need == 0) return "unknown";
    IntPtr buf = Marshal.AllocHGlobal((int)need);
    try {
      GetUserObjectInformationW(h, UOI_NAME, buf, need, out need);
      return Marshal.PtrToStringUni(buf);
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static string ActiveDesktop() {
    IntPtr h = OpenInputDesktop(0, false, GENERIC_ALL);
    if (h == IntPtr.Zero) return "none";
    string n = NameOf(h);
    CloseDesktop(h);
    return n;
  }

  static void AttachActive() {
    IntPtr h = OpenInputDesktop(0, false, GENERIC_ALL);
    if (h != IntPtr.Zero) { SetThreadDesktop(h); CloseDesktop(h); }
  }

  // Log to worker.log beside the exe — tailed by the agent so SendInput failures
  // (wrong session, wrong desktop, UIPI block) surface without a console.
  // NOTE: csc v4.0.30319 is C# 5.0 — no string interpolation ($""), no expression-bodied members.
  static string LOG = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "worker.log");
  static void L(string m) {
    try { File.AppendAllText(LOG, "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + m + "\n"); } catch {}
  }

  // Atomic down+up in ONE SendInput call — matches the .docs/login pattern that
  // was verified working. The Winlogon credential UI can drop keystrokes when
  // key-down and key-up are sent in separate SendInput calls.
  static void SendVK(ushort vk) {
    INPUT[] inp = new INPUT[2];
    inp[0].type = INPUT_KEYBOARD; inp[0].u.ki.wVk = vk;
    inp[1].type = INPUT_KEYBOARD; inp[1].u.ki.wVk = vk; inp[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
    uint r = SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT)));
    if (r == 0) L("SendInput FAIL vk=0x" + vk.ToString("X2") + " winerr=" + Marshal.GetLastWin32Error());
  }

  // Single event (down or up) for modifier-hold sequences (shifted chars).
  static void SendKey(ushort vk, bool up) {
    INPUT inp = new INPUT { type = INPUT_KEYBOARD };
    inp.u.ki.wVk = vk;
    if (up) inp.u.ki.dwFlags = KEYEVENTF_KEYUP;
    INPUT[] arr = new INPUT[] { inp };
    uint r = SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    if (r == 0) L("SendKey FAIL vk=0x" + vk.ToString("X2") + " up=" + up + " winerr=" + Marshal.GetLastWin32Error());
  }

  // VkKeyScanW high byte: bit0 = Shift, bit1 = Ctrl, bit2 = Alt. Only Shift handled here.
  static void TypeText(string text) {
    int sess = Process.GetCurrentProcess().SessionId;
    string beforeDesk = ActiveDesktop();
    L("TYPE session=" + sess + " desktop=" + beforeDesk + " len=" + text.Length);
    AttachActive();
    string afterDesk = ActiveDesktop();
    if (afterDesk != beforeDesk) L("  attach flipped desktop " + beforeDesk + " -> " + afterDesk);
    for (int i = 0; i < 30; i++) { SendVK(VK_BACK); Thread.Sleep(20); }
    Thread.Sleep(80);
    foreach (char c in text) {
      short k = VkKeyScanW(c);
      ushort vk = (ushort)(k & 0xFF);
      bool shift = (k & 0x0100) != 0;
      // Never log the char or its vk — TYPE carries the user's password.
      if (shift) {
        SendKey(VK_SHIFT, false);
        SendKey(vk, false); Thread.Sleep(25); SendKey(vk, true);
        SendKey(VK_SHIFT, true);
      } else {
        SendVK(vk);  // atomic — same path as .docs/login for digits
      }
      Thread.Sleep(30);
    }
    Thread.Sleep(80);
    SendVK(VK_RETURN);
    L("TYPE done");
  }

  static void Main() {
    // Single-instance guard. The pipe is created with maxInstances=1, so a second
    // worker could never serve — it would spin in the retry loop forever while
    // holding a lock on this .exe, blocking every future csc rebuild.
    //
    // Held in a static field, not a local: GC.KeepAlive only protects up to the
    // call, after which nothing references a local mutex for the rest of this
    // infinite loop — the finalizer would release it mid-run and let a second
    // worker in. A static root lives as long as the process.
    // Never let the guard itself kill the worker: if the mutex can't be created
    // or opened (ACL, exotic session), carry on unguarded — the pipe's own
    // maxInstances=1 still prevents two workers from serving at once.
    try {
      bool isNew;
      _instanceLock = new Mutex(true, MUTEX_NAME, out isNew);
      if (!isNew) {
        // The previous worker may be shutting down right now (agent issued STOP,
        // then relaunched us via the task). Wait for it to release rather than
        // exiting into a gap where no worker is running at all.
        if (!_instanceLock.WaitOne(HANDOFF_WAIT_MS)) { L("another worker still holds the lock — exiting"); return; }
        L("took over from a previous instance");
      }
    } catch (Exception e) { L("mutex guard unavailable: " + e.Message); }
    try { L("start session=" + Process.GetCurrentProcess().SessionId + " pid=" + Process.GetCurrentProcess().Id + " user=" + WindowsIdentity.GetCurrent().Name); } catch {}
    // ACL: SYSTEM + Administrators + Authenticated Users so the user-scope agent can connect.
    var sec = new PipeSecurity();
    sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
    sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
    sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));

    while (true) {
      NamedPipeServerStream srv;
      try {
        srv = new NamedPipeServerStream(PIPE, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 0, sec);
      } catch {
        Thread.Sleep(1000); continue;
      }
      try {
        srv.WaitForConnection();
        var sr = new StreamReader(srv);
        var sw = new StreamWriter(srv) { AutoFlush = true };
        string line;
        while ((line = sr.ReadLine()) != null) {
          line = line.Trim();
          if (line.Length == 0) continue;
          if (line == "VERSION") {
            sw.WriteLine("VERSION " + VERSION);
          } else if (line == "STATE") {
            sw.WriteLine("DESKTOP " + ActiveDesktop());
          } else if (line.StartsWith("TYPE ")) {
            TypeText(line.Substring(5));
            sw.WriteLine("OK");
          } else if (line == "STOP") {
            sw.WriteLine("OK");
            // Clean exit: STOP is an intentional shutdown (user toggled Off, or
            // the agent is freeing the locked exe for a rebuild). Restarting here
            // would defeat both. The boot task brings it back next reboot.
            try { srv.Dispose(); } catch { }
            Environment.Exit(0);
          } else {
            sw.WriteLine("ERR unknown");
          }
        }
      } catch {
      } finally {
        try { srv.Dispose(); } catch { }
      }
    }
  }
}
