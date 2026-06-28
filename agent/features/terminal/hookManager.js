// AI Tool Hook Management (Claude Code, Codex, Gemini CLI, OpenCode)
import os from "os";
import fs from "fs";
import path from "path";
import { SERVER_PORT, PATHS as APP_PATHS, CLAUDE_SCROLLBACK_ENV } from "../../lib/constants.js";

const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;
const OPENCODE_PLUGIN_MARK = "9remoteNotify";

// Backup of user's original env values, to restore on disable
const CLAUDE_ENV_BACKUP_FILE = path.join(APP_PATHS.STATE, "claudeEnvBackup.json");

const PATHS = {
  claude: () => path.join(os.homedir(), ".claude", "settings.json"),
  codex: () => path.join(os.homedir(), ".codex", "config.toml"),
  gemini: () => path.join(os.homedir(), ".gemini", "settings.json"),
  opencode: () => path.join(os.homedir(), ".config", "opencode", "plugins", `${OPENCODE_PLUGIN_MARK}.js`),
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

// Codex (TOML)
const CODEX_BLOCK_RE = /\n*# 9Remote notification\nnotify\s*=.*\n?/g;

function enableCodexHook() {
  const filePath = PATHS.codex();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cmd = buildCurlCmd("stop", "codex");
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  content = content.replace(CODEX_BLOCK_RE, "");
  // Trailing newline guarantee, then append managed block
  if (content.length && !content.endsWith("\n")) content += "\n";
  content += `\n# 9Remote notification\nnotify = ["bash", "-c", ${JSON.stringify(cmd)}]\n`;
  fs.writeFileSync(filePath, content, "utf8");
  return { success: true };
}

function disableCodexHook() {
  const filePath = PATHS.codex();
  if (!fs.existsSync(filePath)) return { success: true };
  let content = fs.readFileSync(filePath, "utf8");
  content = content.replace(CODEX_BLOCK_RE, "");
  fs.writeFileSync(filePath, content, "utf8");
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
  const stopUrl = `${NOTIFY_URL}?type=stop&tool=opencode`;
  const notifyUrl = `${NOTIFY_URL}?type=notification&tool=opencode`;
  return `// 9Remote OpenCode notify plugin (auto-generated)
const post = (url) => {
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch {}
};
export const ${OPENCODE_PLUGIN_MARK} = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") post(${JSON.stringify(stopUrl)});
    else if (event.type === "permission.asked") post(${JSON.stringify(notifyUrl)});
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

export const SUPPORTED_TOOLS = ["claude", "codex", "gemini", "opencode"];

export function enableToolHook(tool) {
  return ENABLERS[tool]?.() || { success: false, error: "Unknown tool" };
}

export function disableToolHook(tool) {
  return DISABLERS[tool]?.() || { success: false, error: "Unknown tool" };
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
