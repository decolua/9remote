// Block system sleep, allow display sleep — keeps agent reachable 24/7
// while letting screen power down naturally.
import { spawn } from "child_process";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { createLogger } from "./logger.js";

const logger = createLogger("sleep");

const PLATFORM_CMD = {
  // -i idle, -m disk, -s system on AC. NO -d → display can still sleep.
  darwin: { cmd: "caffeinate", args: ["-ims"] },
  // Block idle/sleep/lid; display sleep handled separately via DPMS.
  linux:  { cmd: "systemd-inhibit", args: ["--what=idle:sleep:handle-lid-switch", "--who=9remote", "--why=remote-active", "sleep", "infinity"] },
  // Persistent ES_SYSTEM_REQUIRED + ES_AWAYMODE_REQUIRED. NO ES_DISPLAY_REQUIRED.
  win32:  {
    cmd: "powershell.exe",
    args: ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "Add-Type -Name K -Namespace W -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32\")]public static extern uint SetThreadExecutionState(uint e);'; [void][W.K]::SetThreadExecutionState(0x80000041); while($true){Start-Sleep 3600}"]
  }
};

let proc = null;

export function start() {
  if (!REMOTE_CONFIG.sleepInhibit?.enabled) return;
  if (proc) return;
  const c = PLATFORM_CMD[process.platform];
  if (!c) return;
  try {
    proc = spawn(c.cmd, c.args, { stdio: "ignore", windowsHide: true });
    proc.on("error", (err) => { logger.warn(`inhibitor error: ${err.message}`); proc = null; });
    proc.on("exit", () => { proc = null; });
    logger.info(`💤 Sleep inhibitor started (${c.cmd})`);
  } catch (err) {
    logger.warn(`Failed to start sleep inhibitor: ${err.message}`);
    proc = null;
  }
}

export function stop() {
  if (!proc) return;
  try { proc.kill(); } catch {}
  proc = null;
}
