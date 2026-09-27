// Daemon protocol/code version — bump when daemon behavior changes.
export const DAEMON_VERSION = "72";

// Staging directory for pasted/attached files before handing to CLI.
export const UPLOAD_DIR = "/tmp/9remote-uploads";

// PowerShell prompt function emitting OSC 7 for cwd tracking.
export function psOsc7PromptCommand() {
  return `function prompt { $p = $PWD.Path -replace '\\\\','/'; "$([char]27)]7;file://$([System.Net.Dns]::GetHostName())$p$([char]27)\\PS $($PWD.Path)> " }`;
}

export function buildShellArgs(shellConfig) {
  if (shellConfig.id === "powershell" || shellConfig.id === "pwsh") {
    return [...shellConfig.args, "-NoExit", "-Command", psOsc7PromptCommand()];
  }
  return shellConfig.args;
}

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

// Filter Windows shells by binary existence.
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

// PTY bounds: narrow cols irreversibly reflows scrollback.
export const RESIZE_MIN_COLS = 20;
export const RESIZE_MIN_ROWS = 4;
export const RESIZE_MAX_COLS = 2000;
export const RESIZE_MAX_ROWS = 500;
// Delay shrinking to allow soft-keyboard/panel transitions to settle.
export const RESIZE_SHRINK_SETTLE_MS = 300;

export const SESSION_NAME_MAX = 40;
export const AUTO_NAME_RE = /^(Term|Terminal) \d+$/;
export const AUTO_NAME_DEBOUNCE_MS = 800;

// Max bytes per slice to keep base64 envelope under 64KB SCTP limit.
export const OUTPUT_SLICE_BYTES = 45 * 1024;

export const HISTORY = {
  CHUNK_BYTES: 32 * 1024,
  HEAD_BYTES: 512 * 1024,
  HEAD_LINES: 60,
  TITLE_MAX: 120,
  SCAN_FILE_CAP: 200,
  SCAN_DEPTH: 4,
  PER_AGENT_LIMIT: 50,
  DEFAULT_LIMIT: 100,
  CACHE_TTL_MS: 30 * 1000
};
