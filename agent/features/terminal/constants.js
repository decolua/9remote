// Daemon protocol/code version — bump only when daemon behavior changes (independent of CLI version)
// v31: buffer storage string[]→Buffer[] (byte-accurate offsets for scroll-up history fetch).
// v33: small echo flushes sync (realtime typing); large bursts still coalesce via setImmediate.
// v34: drop setImmediate coalesce entirely — sync flush each onData chunk (fixes rapid-typing backlog).
// v35: add latency trace points (input.write/onData/broadcast) — temporary debugging.
// v37: restore same-tick coalesce (setImmediate) — rapid-typing lag was the agent git spawn, not this.
// v38: zsh PTY now sources ~/.zprofile + ~/.zlogin (ZDOTDIR=temp dir previously skipped them).
// v45: OSC 7 cwd tracking for cmd.exe (PROMPT env + re-inject) + strip leading slash on Win drive paths.
// v46: PowerShell OSC 7 injected via `-NoExit -Command` arg instead of stdin write (no echo, no race).
// v47: join replay + history chunk 128KB → 256KB (deeper rejoin/load-more).
// v48: strip NODE_ENV from shell env — dev-mode agent leaked NODE_ENV=development into user terminals.
// v49: track foreground process changes and broadcast to agent (detect agent CLI exit/Ctrl+C).
// v50: foreground process polling and auto-clear session agent on exit.
// v51: event-driven process check on output settle/input (no 500ms polling); preserve completion badges.
// v53: persistent AI sessions (claude process + chat log) with seq-stamped replay,
//      tool-output cap, permission_resolved broadcast, deferred mode/model restart.
// v54: AI stop interrupts the turn instead of killing the CLI; turn-boundary snapshot
//      flush (150ms debounce); stale-process guard; zombie-snapshot guard on destroy.
// v55: compact AI streaming events on turn complete; recover history from jsonl transcripts;
//      in-memory pure hydration batching to eliminate freeze/crash.
// v56: aiOptions accepts `resume` so /resume rebinds the claude session id and restarts.
// v57: aiOptions accepts `effort` (--effort) and persists it with the session snapshot.
// v59: recoverFromClaudeTranscript finds the transcript by id, not by the terminal's
//      current cwd — a terminal that `cd`'d away still reopens its chat with history.
// v60: aiPrompt accepts attachments — images as content blocks, other files staged
//      to the upload dir and named in the text.
// v61: aiPublicState exposes cliSessionId — the agent records which conversation a
//      chat-UI terminal is showing, so the history list reopens it the same way.
// v62: AI joins replay only the last 128KB (aiPublicState.hasMore); older events
//      fetched on scroll-up via aiHistory.
export const DAEMON_VERSION = "62";

// Where pasted/attached files are staged before being handed to a CLI. Lives here,
// not in ptyHelper, because the daemon needs it too — ptyHelper pulls in agent-side
// modules (statusManager, conversationModes) the daemon must not drag along.
export const UPLOAD_DIR = "/tmp/9remote-uploads";

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

// Resize guard — PTY cols is a ONE-WAY operation: a shell that re-wraps its
// scrollback at a narrow width can never restore it, so a transient bad size is
// permanent damage. The client already filters, but this is the trust boundary
// (multiple clients share one session, and old clients keep sending).
// Floor: the narrowest real layout is ~42 cols (360px phone at 13px mono), so
// anything under 20 is a mid-transition measurement, not a device.
export const RESIZE_MIN_COLS = 20;
export const RESIZE_MIN_ROWS = 4;
// Sanity ceiling — beyond this it's a malformed payload, not a display.
export const RESIZE_MAX_COLS = 2000;
export const RESIZE_MAX_ROWS = 500;
// Shrinking is the damaging direction, so it waits out a settle window (a panel
// transition or soft-keyboard shrink cancels itself within it). Growing applies
// immediately — it costs nothing and keeps rotate-to-landscape responsive.
export const RESIZE_SHRINK_SETTLE_MS = 300;

// Auto-named terminals follow their conversation's title, trimmed to what a tab
// can show. Longer titles are cut with an ellipsis; the full text stays in the
// history row.
export const SESSION_NAME_MAX = 40;
// Terminals created before autoNamed existed: a name still in the generated
// shape was never the user's, so it may follow its conversation like a new one.
export const AUTO_NAME_RE = /^(Term|Terminal) \d+$/;
// A finished turn can arrive as several events at once — collapse them into one
// naming pass rather than re-reading the same transcript per event.
export const AUTO_NAME_DEBOUNCE_MS = 800;

// Max raw bytes per output event, fragmented at the emission source. 45KB raw →
// ~60KB base64 + envelope stays under the 64KB SCTP message cap, so the RTC
// control DC carries the whole terminal stream — no WS detour mid-session.
export const OUTPUT_SLICE_BYTES = 45 * 1024;

// Agent CLI conversation history (agentHistory.js). The head budgets bound what
// one transcript costs to identify: enough lines to pass a session's metadata
// and its first user turn, never enough to read a long conversation.
export const HISTORY = {
  // Read in small chunks up to a generous ceiling: most transcripts answer in
  // the first chunk, and only a preamble-heavy one pays for more.
  CHUNK_BYTES: 32 * 1024,
  HEAD_BYTES: 512 * 1024,
  HEAD_LINES: 60,
  TITLE_MAX: 120,
  // Stores that bury the cwd in the file are walked newest-first under this cap,
  // so a machine with thousands of transcripts still answers in one readdir pass.
  SCAN_FILE_CAP: 200,
  SCAN_DEPTH: 4,
  PER_AGENT_LIMIT: 50,
  DEFAULT_LIMIT: 100,
  CACHE_TTL_MS: 30 * 1000
};
