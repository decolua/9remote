// AI Tool Hook Management (Claude Code, Codex, Gemini CLI, OpenCode)
import os from "os";
import fs from "fs";
import path from "path";
import { SERVER_PORT, PATHS as APP_PATHS, CLAUDE_SCROLLBACK_ENV, AI_TOOLS } from "../../lib/constants.js";

const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;
// JS identifier cannot start with a digit, so plugin export name differs from the file mark
const OPENCODE_PLUGIN_MARK = "nineRemoteNotify";

// Backup of user's original env values, to restore on disable
const CLAUDE_ENV_BACKUP_FILE = path.join(APP_PATHS.STATE, "claudeEnvBackup.json");

const PATHS = {
  claude: () => path.join(os.homedir(), ".claude", "settings.json"),
  codex: () => path.join(os.homedir(), ".codex", "config.toml"),
  gemini: () => path.join(os.homedir(), ".gemini", "settings.json"),
  opencode: () => path.join(os.homedir(), ".config", "opencode", "plugin", `${OPENCODE_PLUGIN_MARK}.js`),
};

const TOOL_DIRS = {
  claude: () => path.join(os.homedir(), ".claude"),
  codex: () => path.join(os.homedir(), ".codex"),
  gemini: () => path.join(os.homedir(), ".gemini"),
  opencode: () => [path.join(os.homedir(), ".config", "opencode"), path.join(os.homedir(), ".opencode")],
};

const buildCurlCmd = (type, tool) =>
  `command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 "${NOTIFY_URL}?type=${type}&sessionId=$NINE_REMOTE_SESSION_ID&tool=${tool}" > /dev/null 2>&1 & true`;

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}
  return {};
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// Backup original env values then apply scrollback fix
function applyClaudeEnv(settings) {
  const backup = {};
  const env = settings.env || {};
  for (const k of Object.keys(CLAUDE_SCROLLBACK_ENV)) backup[k] = env[k] ?? null;
  writeJsonFile(CLAUDE_ENV_BACKUP_FILE, backup);
  settings.env = { ...env, ...CLAUDE_SCROLLBACK_ENV };
}

// Restore original env values (null = key didn't exist, so delete)
function restoreClaudeEnv(settings) {
  const backup = readJsonFile(CLAUDE_ENV_BACKUP_FILE);
  const env = settings.env || {};
  for (const k of Object.keys(CLAUDE_SCROLLBACK_ENV)) {
    if (backup[k] == null) delete env[k];
    else env[k] = backup[k];
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  try { if (fs.existsSync(CLAUDE_ENV_BACKUP_FILE)) fs.unlinkSync(CLAUDE_ENV_BACKUP_FILE); } catch {}
}

// Claude Code
function enableClaudeHook() {
  const filePath = PATHS.claude();
  const settings = readJsonFile(filePath);
  const stopCmd = buildCurlCmd("stop", "claude");
  const notifyCmd = buildCurlCmd("notification", "claude");
  settings.hooks = {
    ...(settings.hooks || {}),
    Stop: [{ matcher: "", hooks: [{ type: "command", command: stopCmd }] }],
    Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [{ type: "command", command: notifyCmd }] }],
  };
  applyClaudeEnv(settings);
  writeJsonFile(filePath, settings);
  return { success: true };
}

function disableClaudeHook() {
  const filePath = PATHS.claude();
  const settings = readJsonFile(filePath);
  if (settings.hooks) {
    delete settings.hooks.Stop;
    delete settings.hooks.Notification;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  restoreClaudeEnv(settings);
  writeJsonFile(filePath, settings);
  return { success: true };
}

// Codex (TOML) — only ONE active `notify` is allowed, so we wrap any pre-existing one.
// `notify` is a top-level key, so it MUST live before the first [section]; we keep our block at the file head.
const CODEX_BLOCK_RE = /# 9Remote notification\nnotify\s*=.*\n?/g;
// Marker prefix used to disable (comment out) the user's original notify so it can be restored later
const CODEX_SAVED_PREFIX = "# 9Remote-saved: ";
// Split TOML head (before first [section]) from the rest; notify is only valid in the head
function splitCodexHead(content) {
  const idx = content.search(/^\[/m);
  return idx === -1 ? [content, ""] : [content.slice(0, idx), content.slice(idx)];
}
// Match a top-level active notify line (not commented, not our saved marker)
const CODEX_ACTIVE_NOTIFY_RE = /^notify\s*=\s*(\[[^\n]*\])\s*$/m;

function enableCodexHook() {
  const filePath = PATHS.codex();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  content = content.replace(CODEX_BLOCK_RE, "");

  let [head, rest] = splitCodexHead(content);

  // Chain the user's existing top-level notify (if any) after ours: run /notify, then exec original
  let chain = "";
  const match = head.match(CODEX_ACTIVE_NOTIFY_RE);
  if (match) {
    try {
      const argv = JSON.parse(match[1]);
      if (Array.isArray(argv) && argv.length) chain = ` ; exec ${argv.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ")} "$@"`;
    } catch {}
    head = head.replace(CODEX_ACTIVE_NOTIFY_RE, `${CODEX_SAVED_PREFIX}$&`);
  }

  const cmd = `${buildCurlCmd("stop", "codex")}${chain}`;
  const block = `# 9Remote notification\nnotify = ["bash", "-c", ${JSON.stringify(cmd)}, "9remote"]\n`;
  if (head.length && !head.endsWith("\n")) head += "\n";
  fs.writeFileSync(filePath, head + block + rest, "utf8");
  return { success: true };
}

function disableCodexHook() {
  const filePath = PATHS.codex();
  if (!fs.existsSync(filePath)) return { success: true };
  let content = fs.readFileSync(filePath, "utf8");
  content = content.replace(CODEX_BLOCK_RE, "");
  // Restore the user's original notify we commented out on enable
  content = content.replace(new RegExp(`^${CODEX_SAVED_PREFIX}(notify\\s*=.*)$`, "m"), "$1");
  // Ensure the head's last key is newline-separated from the first [section]
  let [head, rest] = splitCodexHead(content);
  if (rest && head.length && !head.endsWith("\n")) head += "\n";
  fs.writeFileSync(filePath, head + rest, "utf8");
  return { success: true };
}

// Gemini CLI
function enableGeminiHook() {
  const filePath = PATHS.gemini();
  const settings = readJsonFile(filePath);
  const stopCmd = buildCurlCmd("stop", "gemini");
  const notifyCmd = buildCurlCmd("notification", "gemini");
  settings.hooks = {
    ...(settings.hooks || {}),
    enabled: true,
    AfterAgent: [{ matcher: "", hooks: [{ name: "9remote-stop", type: "command", command: stopCmd, description: "9Remote stop notify" }] }],
    Notification: [{ matcher: "", hooks: [{ name: "9remote-notification", type: "command", command: notifyCmd, description: "9Remote input-needed notify" }] }],
  };
  settings.tools = { ...(settings.tools || {}), enableHooks: true };
  writeJsonFile(filePath, settings);
  return { success: true };
}

function disableGeminiHook() {
  const filePath = PATHS.gemini();
  const settings = readJsonFile(filePath);
  if (settings.hooks) {
    delete settings.hooks.AfterAgent;
    delete settings.hooks.Notification;
    delete settings.hooks.enabled;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeJsonFile(filePath, settings);
  return { success: true };
}

// OpenCode (JS plugin file)
function buildOpencodePlugin() {
  return `// 9Remote OpenCode notify plugin (auto-generated)
const base = ${JSON.stringify(NOTIFY_URL)};
const post = (type) => {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  const url = base + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=opencode";
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch {}
};
export const ${OPENCODE_PLUGIN_MARK} = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") post("stop");
    else if (event.type === "permission.asked") post("notification");
  },
});
`;
}

function enableOpencodeHook() {
  const filePath = PATHS.opencode();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buildOpencodePlugin(), "utf8");
  return { success: true };
}

function disableOpencodeHook() {
  const filePath = PATHS.opencode();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return { success: true };
}

// Status checks
function isToolHookEnabled(tool) {
  switch (tool) {
    case "claude": {
      const s = readJsonFile(PATHS.claude());
      return !!(s.hooks?.Stop || s.hooks?.Notification);
    }
    case "codex": {
      const fp = PATHS.codex();
      return fs.existsSync(fp) && fs.readFileSync(fp, "utf8").includes("# 9Remote notification");
    }
    case "gemini": {
      const s = readJsonFile(PATHS.gemini());
      return !!(s.hooks?.AfterAgent || s.hooks?.Notification);
    }
    case "opencode":
      return fs.existsSync(PATHS.opencode());
    default: return false;
  }
}

function isToolInstalled(tool) {
  const dirs = TOOL_DIRS[tool]?.();
  if (!dirs) return false;
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.some((d) => fs.existsSync(d));
}

const ENABLERS = { claude: enableClaudeHook, codex: enableCodexHook, gemini: enableGeminiHook, opencode: enableOpencodeHook };
const DISABLERS = { claude: disableClaudeHook, codex: disableCodexHook, gemini: disableGeminiHook, opencode: disableOpencodeHook };

export const SUPPORTED_TOOLS = AI_TOOLS;

export function enableToolHook(tool) {
  return ENABLERS[tool]?.() || { success: false, error: "Unknown tool" };
}

export function disableToolHook(tool) {
  return DISABLERS[tool]?.() || { success: false, error: "Unknown tool" };
}

// Auto-enable hooks for every installed AI tool on startup. Idempotent: skips not-installed/already-enabled.
// To support a new tool later: add it to SUPPORTED_TOOLS + ENABLERS + PATHS + TOOL_DIRS — picked up here automatically.
export function autoEnableInstalledHooks() {
  const result = {};
  for (const tool of SUPPORTED_TOOLS) {
    if (!isToolInstalled(tool) || isToolHookEnabled(tool)) continue;
    try { result[tool] = enableToolHook(tool).success; } catch { result[tool] = false; }
  }
  return result;
}

export function getHookStatus() {
  const status = {};
  for (const tool of SUPPORTED_TOOLS) {
    status[tool] = { installed: isToolInstalled(tool), enabled: isToolHookEnabled(tool) };
  }
  return status;
}

// Reconcile on startup: if user enabled Claude hook before env-fix existed, apply env now
export function reconcileClaudeEnv() {
  const filePath = PATHS.claude();
  const settings = readJsonFile(filePath);
  if (!settings.hooks?.Stop && !settings.hooks?.Notification) return;
  const env = settings.env || {};
  const needsApply = Object.keys(CLAUDE_SCROLLBACK_ENV).some(k => env[k] !== CLAUDE_SCROLLBACK_ENV[k]);
  if (!needsApply) return;
  applyClaudeEnv(settings);
  writeJsonFile(filePath, settings);
}
