// Daemon protocol/code version — bump only when daemon behavior changes (independent of CLI version)
// v31: buffer storage string[]→Buffer[] (byte-accurate offsets for scroll-up history fetch).
// v33: small echo flushes sync (realtime typing); large bursts still coalesce via setImmediate.
// v34: drop setImmediate coalesce entirely — sync flush each onData chunk (fixes rapid-typing backlog).
// v35: add latency trace points (input.write/onData/broadcast) — temporary debugging.
// v37: restore same-tick coalesce (setImmediate) — rapid-typing lag was the agent git spawn, not this.
// v38: zsh PTY now sources ~/.zprofile + ~/.zlogin (ZDOTDIR=temp dir previously skipped them).
// v45: OSC 7 cwd tracking for cmd.exe (PROMPT env + re-inject) + strip leading slash on Win drive paths.
// v46: PowerShell OSC 7 injected via `-NoExit -Command` arg instead of stdin write (no echo, no race).
export const DAEMON_VERSION = "46";

// PowerShell prompt function emitting OSC 7 so the client can track cwd. Passed via
// `-NoExit -Command` at spawn — running it pre-REPL avoids PSReadLine echoing the line.
export function psOsc7PromptCommand() {
  return `function prompt { $p = $PWD.Path -replace '\\\\','/'; "$([char]27)]7;file://$([System.Net.Dns]::GetHostName())$p$([char]27)\\PS $($PWD.Path)> " }`;
}

// Compute spawn args; PowerShell/pwsh get the OSC 7 prompt injected as a startup command.
export function buildShellArgs(shellConfig) {
  if (shellConfig.id === "powershell" || shellConfig.id === "pwsh") {
    return [...shellConfig.args, "-NoExit", "-Command", psOsc7PromptCommand()];
  }
  return shellConfig.args;
}

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

import fs from "fs";

// Only Windows exposes shell picker; Unix uses default shell silently.
// Filter by path existence so machines without pwsh don't show a broken option.
export function getShellList() {
  if (process.platform !== "win32") return [];
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  return SHELL_OPTIONS.win32.filter((s) => {
    try { return fs.existsSync(s.path) || fs.existsSync(`${sysRoot}\\System32\\${s.path}`); }
    catch { return true; }
  });
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
