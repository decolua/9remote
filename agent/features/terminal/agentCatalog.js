import fs from "fs";
import path from "path";

// TUI agent CLIs offered in the new-terminal modal (Orca-style quick launch).
// cmd = binary name used for PATH detection AND the startup command typed into
// the shell — often differs from the product name (e.g. Continue → cn).
// yolo = the CLI's own flag for running without per-action approval prompts;
// yoloEnv = same intent for CLIs that read an env var instead of a flag.
// Agents with neither offer no skip-permission toggle.
export const AGENT_CLIS = [
  { id: "claude", label: "Claude Code", cmd: "claude", yolo: "--dangerously-skip-permissions" },
  { id: "codex", label: "Codex", cmd: "codex", yolo: "--dangerously-bypass-approvals-and-sandbox" },
  { id: "gemini", label: "Gemini", cmd: "gemini", yolo: "--yolo" },
  { id: "copilot", label: "GitHub Copilot", cmd: "copilot", yolo: "--yolo" },
  { id: "cursor", label: "Cursor", cmd: "cursor-agent", yolo: "--yolo" },
  { id: "opencode", label: "OpenCode", cmd: "opencode", yolo: "--dangerously-skip-permissions" },
  { id: "aider", label: "Aider", cmd: "aider", yolo: "--yes-always" },
  { id: "grok", label: "Grok", cmd: "grok", yolo: "--permission-mode bypassPermissions" },
  { id: "amp", label: "Amp", cmd: "amp", yolo: "--dangerously-allow-all" },
  { id: "droid", label: "Droid", cmd: "droid" },
  { id: "goose", label: "Goose", cmd: "goose", yoloEnv: { GOOSE_MODE: "auto" } },
  { id: "kilo", label: "Kilocode", cmd: "kilo", yolo: "--dangerously-skip-permissions" },
  { id: "crush", label: "Charm Crush", cmd: "crush", yolo: "--yolo" },
  { id: "qwen-code", label: "Qwen Code", cmd: "qwen", yolo: "--approval-mode yolo" },
  { id: "kimi", label: "Kimi", cmd: "kimi", yolo: "--yolo" },
  { id: "openclaude", label: "OpenClaude", cmd: "openclaude", yolo: "--dangerously-skip-permissions" },
  { id: "cline", label: "Cline", cmd: "cline", yolo: "--auto-approve true" },
  { id: "rovo", label: "Rovo Dev", cmd: "rovo", yolo: "--yolo" },
  { id: "hermes", label: "Hermes", cmd: "hermes", yolo: "--yolo" },
  { id: "devin", label: "Devin", cmd: "devin", yolo: "--permission-mode bypass" },
  { id: "auggie", label: "Auggie", cmd: "auggie" },
  { id: "continue", label: "Continue", cmd: "cn", yolo: "--allow \"*\"" },
  { id: "antigravity", label: "Antigravity", cmd: "agy", yolo: "--dangerously-skip-permissions" },
  { id: "mistral-vibe", label: "Mistral Vibe", cmd: "vibe", yolo: "--agent auto-approve" },
  { id: "mimo-code", label: "MiMo Code", cmd: "mimo" },
  { id: "trae", label: "Trae", cmd: "traecli", yolo: "--yolo" },
  { id: "ante", label: "Ante", cmd: "ante", yolo: "--yolo" },
  { id: "kiro", label: "Kiro", cmd: "kiro-cli", yolo: "--trust-all-tools" },
  { id: "codebuff", label: "Codebuff", cmd: "codebuff" },
  { id: "prime-agent", label: "Prime Agent", cmd: "prime-agent" },
  { id: "command-code", label: "Command Code", cmd: "command-code", yolo: "--yolo" },
  { id: "autohand", label: "Autohand Code", cmd: "autohand", yolo: "--unrestricted" },
  { id: "pi", label: "Pi", cmd: "pi" },
  { id: "omp", label: "OMP", cmd: "omp" },
  { id: "openclaw", label: "OpenClaw", cmd: "openclaw" }
];

const DETECT_CACHE_TTL_MS = 60 * 1000;
let detectCache = { at: 0, result: [] };

function pathDirs() {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean);
}

// Windows resolves bare names through PATHEXT permutations
function windowsExts() {
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean);
}

function isExecutableFile(candidate) {
  try {
    // stat (not lstat) so symlinked CLIs resolve to their real target
    const stats = fs.statSync(candidate);
    if (stats.isDirectory()) return false;
    if (process.platform === "win32") return stats.isFile();
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Pure-fs PATH lookup (no which/where subprocess spawn — privilege-management
// software gates each spawn and stalls startup). Returns only found agents.
export function detectAgentClis(force = false) {
  // Cache even an empty result — a host with no agents must not rescan on every modal open
  if (!force && detectCache.at && Date.now() - detectCache.at < DETECT_CACHE_TTL_MS) {
    return detectCache.result;
  }
  const dirs = pathDirs();
  const exts = process.platform === "win32" ? windowsExts() : [""];
  // Env-var yolo needs a `VAR=value cmd` prefix, which cmd.exe/PowerShell don't parse
  const supportsEnvPrefix = process.platform !== "win32";
  const result = AGENT_CLIS.filter((agent) =>
    dirs.some((dir) => exts.some((ext) => isExecutableFile(path.join(dir, `${agent.cmd}${ext}`))))
  ).map(({ id, label, cmd, yolo, yoloEnv }) => ({
    id,
    label,
    cmd,
    ...(yolo ? { yolo } : {}),
    ...(yoloEnv && supportsEnvPrefix ? { yoloEnv } : {})
  }));
  detectCache = { at: Date.now(), result };
  return result;
}
