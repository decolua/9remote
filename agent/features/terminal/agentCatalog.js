import fs from "fs";
import path from "path";
import os from "os";

// TUI agent CLIs offered in the new-terminal modal.
// cmd = binary name used for PATH detection AND the startup command typed into
// the shell — often differs from the product name (e.g. Continue → cn).
// yolo = the CLI's own flag for running without per-action approval prompts;
// yoloEnv = same intent for CLIs that read an env var instead of a flag.
// Agents with neither offer no skip-permission toggle.
// short = compact name for tab defaults/placeholder; buttons keep the full label.
export const AGENT_CLIS = [
  { id: "claude", label: "Claude Code", short: "Claude", cmd: "claude", yolo: "--dangerously-skip-permissions", sessionIdKeys: ["session_id"], resume: (id) => `claude --resume ${id}` },
  { id: "codex", label: "Codex", cmd: "codex", yolo: "--dangerously-bypass-approvals-and-sandbox", sessionIdKeys: ["session_id"], resume: (id) => `codex resume ${id}` },
  { id: "copilot", label: "GitHub Copilot", short: "Copilot", cmd: "copilot", yolo: "--yolo", resume: (id) => `copilot --resume=${id}` },
  { id: "cursor", label: "Cursor", cmd: "cursor-agent", yolo: "--yolo", resume: (id) => `cursor-agent --resume ${id}` },
  { id: "opencode", label: "OpenCode", cmd: "opencode", yolo: "--dangerously-skip-permissions", sessionIdKeys: ["sessionID"], resume: (id) => `opencode --session ${id}` },
  { id: "aider", label: "Aider", cmd: "aider", yolo: "--yes-always" },
  { id: "grok", label: "Grok", cmd: "grok", yolo: "--permission-mode bypassPermissions", sessionIdKeys: ["sessionId", "session_id"], resume: (id) => `grok --resume ${id}` },
  { id: "amp", label: "Amp", cmd: "amp", yolo: "--dangerously-allow-all" },
  { id: "droid", label: "Droid", cmd: "droid", sessionIdKeys: ["session_id"], resume: (id) => `droid --resume ${id}` },
  { id: "goose", label: "Goose", cmd: "goose", yoloEnv: { GOOSE_MODE: "auto" } },
  { id: "kilo", label: "Kilocode", cmd: "kilo", yolo: "--dangerously-skip-permissions" },
  { id: "crush", label: "Charm Crush", short: "Crush", cmd: "crush", yolo: "--yolo" },
  { id: "qwen-code", label: "Qwen Code", short: "Qwen", cmd: "qwen", yolo: "--approval-mode yolo", resume: (id) => `qwen --resume ${id}` },
  { id: "kimi", label: "Kimi", cmd: "kimi", yolo: "--yolo", sessionIdKeys: ["session_id"], resume: (id) => `kimi --session ${id}` },
  { id: "openclaude", label: "OpenClaude", cmd: "openclaude", yolo: "--dangerously-skip-permissions" },
  { id: "cline", label: "Cline", cmd: "cline", yolo: "--auto-approve true" },
  { id: "rovo", label: "Rovo Dev", short: "Rovo", cmd: "rovo", yolo: "--yolo", resume: (id) => `acli rovodev run --restore ${id}` },
  { id: "hermes", label: "Hermes", cmd: "hermes", yolo: "--yolo", resume: (id) => `hermes --resume ${id}` },
  { id: "devin", label: "Devin", cmd: "devin", yolo: "--permission-mode bypass", sessionIdKeys: ["session_id", "sessionId"], resume: (id) => `devin --resume ${id}` },
  { id: "auggie", label: "Auggie", cmd: "auggie" },
  { id: "continue", label: "Continue", cmd: "cn", yolo: "--allow \"*\"" },
  { id: "antigravity", label: "Antigravity", cmd: "agy", yolo: "--dangerously-skip-permissions", sessionIdKeys: ["conversationId"], resume: (id) => `agy --conversation ${id}` },
  { id: "mistral-vibe", label: "Mistral Vibe", short: "Vibe", cmd: "vibe", yolo: "--agent auto-approve" },
  { id: "mimo-code", label: "MiMo Code", short: "MiMo", cmd: "mimo", sessionIdKeys: ["sessionID"], resume: (id) => `mimo --session ${id}` },
  { id: "trae", label: "Trae", cmd: "traecli", yolo: "--yolo" },
  { id: "ante", label: "Ante", cmd: "ante", yolo: "--yolo" },
  { id: "kiro", label: "Kiro", cmd: "kiro-cli", yolo: "--trust-all-tools" },
  { id: "codebuff", label: "Codebuff", cmd: "codebuff" },
  { id: "prime-agent", label: "Prime Agent", short: "Prime", cmd: "prime-agent", sessionIdKeys: ["session_id"], resume: (id) => `prime-agent --resume ${id}` },
  { id: "command-code", label: "Command Code", short: "Command", cmd: "command-code", yolo: "--yolo" },
  { id: "autohand", label: "Autohand Code", short: "Autohand", cmd: "autohand", yolo: "--unrestricted" },
  { id: "pi", label: "Pi", cmd: "pi", sessionIdKeys: ["session_id"], resume: (id) => `pi --session ${id}` },
  { id: "omp", label: "OMP", cmd: "omp", sessionIdKeys: ["session_id"], resume: (id) => `omp --resume ${id}` },
  { id: "openclaw", label: "OpenClaw", cmd: "openclaw", resume: (id) => `openclaw --resume ${id}` }
];

const AGENT_BY_ID = new Map(AGENT_CLIS.map((a) => [a.id, a]));

export function agentById(agentId) {
  return AGENT_BY_ID.get(agentId) || null;
}

// --- Conversation ids reported by the CLIs' own hooks ---
// Each CLI names the field differently (session_id, sessionID, conversationId),
// so the catalog carries the spelling and every caller reads it the same way.
// A CLI whose hook reports nothing simply has no sessionIdKeys.

// The id ends up typed into the user's PTY by the resume flow, and the notify
// endpoint is localhost-public — so anything that isn't id-shaped is refused here.
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function hookSessionIdKeys(agentId) {
  return AGENT_BY_ID.get(agentId)?.sessionIdKeys || [];
}

/** The conversation id a CLI's hook payload carries, or null when it carries none. */
export function sessionIdFromHookPayload(agentId, payload) {
  if (!payload) return null;
  for (const key of hookSessionIdKeys(agentId)) {
    const value = payload[key];
    if (typeof value === "string" && SESSION_ID_RE.test(value)) return value;
  }
  return null;
}

// --- parsing a typed resume line back into its conversation id ---
// Built from the same `resume` templates resumeCommand uses, so a CLI added to
// the catalog is instantly both emit-able and re-readable — no second spec.
// The placeholder never occurs in a real id, so it marks the id's slot exactly.

// Shared by the resume parser and the launch-line sniffer below: both read the
// same shell-token shape, and the parser is declared first.
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;
const LEADING_TOKEN_RE = /^[^\s;|&'"`]+/;

const RESUME_ID_RE_SOURCE = "[A-Za-z0-9._-]{1,128}";
const resumeTemplates = AGENT_CLIS
  .filter((a) => a.resume)
  .map((a) => {
    const template = a.resume("\u0001");
    const at = template.indexOf("\u0001");
    return { id: a.id, firstWord: template.slice(0, at).trim().split(/\s+/)[0], prefix: template.slice(0, at), suffix: template.slice(at + 1) };
  });
const FIRST_WORD_TO_TEMPLATES = new Map();
for (const t of resumeTemplates) {
  if (!FIRST_WORD_TO_TEMPLATES.has(t.firstWord)) FIRST_WORD_TO_TEMPLATES.set(t.firstWord, []);
  FIRST_WORD_TO_TEMPLATES.get(t.firstWord).push(t);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The agent and conversation id in a typed resume line, or null when the line
 * isn't one. Accepts the env-prefix/sudo/path forms a launch line can take and
 * a trailing bypass flag; anything id-shaped-but-hostile is refused by the same
 * charset the resume id itself allows.
 */
export function parseResumeLine(line = "") {
  let rest = String(line).trim();
  while (true) {
    if (ENV_PREFIX_RE.test(rest)) { rest = rest.replace(ENV_PREFIX_RE, ""); continue; }
    if (/^sudo\s+/.test(rest)) { rest = rest.replace(/^sudo\s+/, ""); continue; }
    break;
  }
  const firstToken = rest.match(LEADING_TOKEN_RE)?.[0];
  if (!firstToken) return null;
  const templates = FIRST_WORD_TO_TEMPLATES.get(firstToken.split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, ""));
  if (!templates) return null;
  for (const t of templates) {
    // The template is written against the bare command word; a typed path
    // (/usr/local/bin/claude) collapses onto it so the rest of the line matches.
    const line = t.firstWord + rest.slice(firstToken.length);
    const re = new RegExp(`^${escapeRe(t.prefix)}(${RESUME_ID_RE_SOURCE})${t.suffix ? escapeRe(t.suffix) : ""}(?:\\s.*)?$`);
    const found = line.match(re);
    if (found) return { agent: t.id, id: found[1] };
  }
  return null;
}

// --- Session agent detection (typed launch line + OSC title) ---
// Fills statusManager's `tool` for sessions whose hook never fired; hook events stay authoritative.

const CMD_TOKEN_TO_ID = new Map(AGENT_CLIS.map((a) => [a.cmd, a.id]));

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

// Claude Code exclusive title prefix: ✳ (✳)
const CLAUDE_EXCLUSIVE_PREFIX_RE = /^\s*✳/;
const BRAILLE_SPINNER_PREFIX_RE = /^\s*[⠀-⣿]\s*/;

// Precompiled whole-token matchers rejecting path separators, file extensions (.md), and hyphen compounds
const AGENT_TOKEN_MATCHERS = [];
for (const { id, label, short, cmd } of AGENT_CLIS) {
  const tokens = new Set([label, ...(short ? [short] : []), cmd]);
  for (const token of tokens) {
    const re = new RegExp(`(?<![\\w./\\\\-])${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\w./\\\\-])`, "i");
    AGENT_TOKEN_MATCHERS.push({ id, re });
  }
}

// Match an OSC 0/2 title against known agent names (label/short/cmd).
// Boundary checks reject file names (CLAUDE.md) and paths. Chooses the agent at the start of the title.
export function agentIdFromTitle(title = "") {
  if (!title) return null;
  if (CLAUDE_EXCLUSIVE_PREFIX_RE.test(title)) return "claude";
  const t = title.trim();
  let earliest = null;
  for (const { id, re } of AGENT_TOKEN_MATCHERS) {
    const match = re.exec(t);
    if (!match) continue;
    const index = match.index;
    const prefix = t.slice(0, index).replace(BRAILLE_SPINNER_PREFIX_RE, "").trim();
    if (!prefix || /[-:|/]$/.test(prefix)) {
      if (!earliest || index < earliest.index) {
        earliest = { id, index };
      }
    }
  }
  return earliest ? earliest.id : null;
}

export const SHELL_PROCESSES = new Set([
  "zsh", "bash", "sh", "dash", "fish", "csh", "tcsh", "ksh",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "login"
]);

export function isShellProcess(procName) {
  if (!procName) return false;
  const base = procName.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  return SHELL_PROCESSES.has(base) || SHELL_PROCESSES.has(procName.toLowerCase());
}

export function agentIdFromProcess(procName) {
  if (!procName) return null;
  const base = procName.toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  return CMD_TOKEN_TO_ID.get(base) || (AGENT_BY_ID.has(base) ? base : null);
}

const DETECT_CACHE_TTL_MS = 60 * 1000;
let detectCache = { at: 0, result: [] };

function pathDirs() {
  const envDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const commonDirs = process.platform === "win32" ? [
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "Programs"),
    path.join(home, ".cargo", "bin"),
  ] : [
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".yarn", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ];
  return Array.from(new Set([...envDirs, ...commonDirs]));
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
