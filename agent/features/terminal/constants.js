// Daemon protocol/code version — bump only when daemon behavior changes (independent of CLI version)
// v31: buffer storage string[]→Buffer[] (byte-accurate offsets for scroll-up history fetch).
// v33: small echo flushes sync (realtime typing); large bursts still coalesce via setImmediate.
// v34: drop setImmediate coalesce entirely — sync flush each onData chunk (fixes rapid-typing backlog).
// v35: add latency trace points (input.write/onData/broadcast) — temporary debugging.
// v37: restore same-tick coalesce (setImmediate) — rapid-typing lag was the agent git spawn, not this.
export const DAEMON_VERSION = "37";

// Shell options for terminal sessions
export const SHELL_OPTIONS = {
  win32: [
    { id: "cmd", label: "Command Prompt", path: "cmd.exe", args: [] },
    { id: "powershell", label: "PowerShell", path: "powershell.exe", args: ["-NoLogo"] },
    { id: "pwsh", label: "PowerShell Core", path: "pwsh.exe", args: ["-NoLogo"] }
  ],
  unix: [
    { id: "bash", label: "Bash", path: "/bin/bash", args: ["-l"] },
    { id: "zsh", label: "Zsh", path: "/bin/zsh", args: ["-l"] },
    { id: "sh", label: "Sh", path: "/bin/sh", args: ["-l"] }
  ]
};

// Only Windows exposes shell picker; Unix uses default shell silently
export function getShellList() {
  return process.platform === "win32" ? SHELL_OPTIONS.win32 : [];
}

export function resolveShell(shellId) {
  if (process.platform === "win32") {
    const found = shellId ? SHELL_OPTIONS.win32.find(s => s.id === shellId) : null;
    if (found) return found;
    const env = process.env.COMSPEC;
    if (env) return { id: "cmd", label: "Command Prompt", path: env, args: [] };
    return SHELL_OPTIONS.win32[0];
  }
  const envShell = process.env.SHELL || "/bin/bash";
  const label = envShell.split("/").pop();
  return { id: label, label, path: envShell, args: ["-l"] };
}
