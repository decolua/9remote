// Wake display on remote activity. Throttled to avoid spawn spam.
// Lets OS handle natural sleep/idle — only nudges display awake when needed.
import { spawn } from "child_process";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";

const PLATFORM_CMD = {
  darwin: () => ({ cmd: "caffeinate", args: ["-u", "-t", String(REMOTE_CONFIG.displayWake.macDurationSec)] }),
  linux:  () => ({ cmd: "xset", args: ["dpms", "force", "on"] }),
  win32:  () => ({
    cmd: "powershell.exe",
    args: ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "Add-Type -Name K -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32\")]public static extern uint SetThreadExecutionState(uint e);'; [void][W.K]::SetThreadExecutionState([uint32]2147483651)"]
  })
};

let lastWake = 0;

export function wakeDisplay() {
  const cfg = REMOTE_CONFIG.displayWake;
  if (!cfg?.enabled) return;
  const now = Date.now();
  if (now - lastWake < cfg.throttleMs) return;
  lastWake = now;
  const build = PLATFORM_CMD[process.platform];
  if (!build) return;
  try {
    const { cmd, args } = build();
    const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    p.on("error", () => {});
    p.unref();
  } catch { /* best-effort */ }
}
