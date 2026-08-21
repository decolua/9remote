import fs from "fs";
import path from "path";

// TUI agent CLIs offered in the new-terminal modal (Orca-style quick launch).
// cmd = binary name used for PATH detection AND the startup command typed into
// the shell — often differs from the product name (e.g. Continue → cn).
// yolo = the CLI's own flag for running without per-action approval prompts;
// yoloEnv = same intent for CLIs that read an env var instead of a flag.
// Agents with neither offer no skip-permission toggle.
// short = compact name for tab defaults/placeholder; buttons keep the full label.
export const AGENT_CLIS = [
  { id: "claude", label: "Claude Code", short: "Claude", cmd: "claude", yolo: "--dangerously-skip-permissions" },
  { id: "codex", label: "Codex", cmd: "codex", yolo: "--dangerously-bypass-approvals-and-sandbox" },
  { id: "gemini", label: "Gemini", cmd: "gemini", yolo: "--yolo" },
  { id: "copilot", label: "GitHub Copilot", short: "Copilot", cmd: "copilot", yolo: "--yolo" },
  { id: "cursor", label: "Cursor", cmd: "cursor-agent", yolo: "--yolo" },
  { id: "opencode", label: "OpenCode", cmd: "opencode", yolo: "--dangerously-skip-permissions" },
  { id: "aider", label: "Aider", cmd: "aider", yolo: "--yes-always" },
  { id: "grok", label: "Grok", cmd: "grok", yolo: "--permission-mode bypassPermissions" },
  { id: "amp", label: "Amp", cmd: "amp", yolo: "--dangerously-allow-all" },
  { id: "droid", label: "Droid", cmd: "droid" },
  { id: "goose", label: "Goose", cmd: "goose", yoloEnv: { GOOSE_MODE: "auto" } },
  { id: "kilo", label: "Kilocode", cmd: "kilo", yolo: "--dangerously-skip-permissions" },
  { id: "crush", label: "Charm Crush", short: "Crush", cmd: "crush", yolo: "--yolo" },
  { id: "qwen-code", label: "Qwen Code", short: "Qwen", cmd: "qwen", yolo: "--approval-mode yolo" },
  { id: "kimi", label: "Kimi", cmd: "kimi", yolo: "--yolo" },
  { id: "openclaude", label: "OpenClaude", cmd: "openclaude", yolo: "--dangerously-skip-permissions" },
  { id: "cline", label: "Cline", cmd: "cline", yolo: "--auto-approve true" },
  { id: "rovo", label: "Rovo Dev", short: "Rovo", cmd: "rovo", yolo: "--yolo" },
  { id: "hermes", label: "Hermes", cmd: "hermes", yolo: "--yolo" },
  { id: "devin", label: "Devin", cmd: "devin", yolo: "--permission-mode bypass" },
  { id: "auggie", label: "Auggie", cmd: "auggie" },
  { id: "continue", label: "Continue", cmd: "cn", yolo: "--allow \"*\"" },
  { id: "antigravity", label: "Antigravity", cmd: "agy", yolo: "--dangerously-skip-permissions" },
  { id: "mistral-vibe", label: "Mistral Vibe", short: "Vibe", cmd: "vibe", yolo: "--agent auto-approve" },
  { id: "mimo-code", label: "MiMo Code", short: "MiMo", cmd: "mimo" },
  { id: "trae", label: "Trae", cmd: "traecli", yolo: "--yolo" },
  { id: "ante", label: "Ante", cmd: "ante", yolo: "--yolo" },
  { id: "kiro", label: "Kiro", cmd: "kiro-cli", yolo: "--trust-all-tools" },
  { id: "codebuff", label: "Codebuff", cmd: "codebuff" },
  { id: "prime-agent", label: "Prime Agent", short: "Prime", cmd: "prime-agent" },
  { id: "command-code", label: "Command Code", short: "Command", cmd: "command-code", yolo: "--yolo" },
  { id: "autohand", label: "Autohand Code", short: "Autohand", cmd: "autohand", yolo: "--unrestricted" },
  { id: "pi", label: "Pi", cmd: "pi" },
  { id: "omp", label: "OMP", cmd: "omp" },
  { id: "openclaw", label: "OpenClaw", cmd: "openclaw" }
];

// Claude's skip-permission flag, reused when resuming a conversation from a session card
export const CLAUDE_YOLO_FLAG = AGENT_CLIS.find((a) => a.id === "claude")?.yolo || "";

// --- Session agent detection (typed launch line + OSC title) ---
// Fills statusManager's `tool` for sessions whose hook never fired; hook events stay authoritative.

const CMD_TOKEN_TO_ID = new Map(AGENT_CLIS.map((a) => [a.cmd, a.id]));
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;
const LEADING_TOKEN_RE = /^[^\s;|&'"`]+/;

// First shell token of a launch line, skipping env prefixes and sudo → agent id.
export function agentIdFromLaunchLine(line = "") {
  let rest = line.trim();
  while (true) {
    if (ENV_PREFIX_RE.test(rest)) { rest = rest.replace(ENV_PREFIX_RE, ""); continue; }
    if (/^sudo\s+/.test(rest)) { rest = rest.replace(/^sudo\s+/, ""); continue; }
    break;
  }
  const token = rest.match(LEADING_TOKEN_RE)?.[0];
  if (!token) return null;
  return CMD_TOKEN_TO_ID.get(token.split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, "")) || null;
}

const isWordChar = (c) => /[a-z0-9]/.test(c);

// Match an OSC 0/2 title against known agent names (label/short/cmd), whole-word.
export function agentIdFromTitle(title = "") {
  const t = title.toLowerCase();
  if (!t) return null;
  for (const { id, label, short, cmd } of AGENT_CLIS) {
    const tokens = new Set([label.toLowerCase(), ...(short ? [short.toLowerCase()] : []), cmd]);
    for (const token of tokens) {
      const i = t.indexOf(token);
      if (i === -1) continue;
      const before = i > 0 ? t[i - 1] : "";
      const after = i + token.length < t.length ? t[i + token.length] : "";
      if (!isWordChar(before) && !isWordChar(after)) return id;
    }
  }
  return null;
}

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
  ).map(({ id, label, short, cmd, yolo, yoloEnv }) => ({
    id,
    label,
    ...(short ? { short } : {}),
    cmd,
    ...(yolo ? { yolo } : {}),
    ...(yoloEnv && supportsEnvPrefix ? { yoloEnv } : {})
  }));
  detectCache = { at: Date.now(), result };
  return result;
}
