// AI Tool Hook Management (Claude, Codex, Gemini, OpenCode, Grok, Cursor, Antigravity, Kiro, Copilot, CodeBuddy, Factory, Qoder, Rovo Dev, Hermes, Amp, Pi)
import os from "os";
import fs from "fs";
import path from "path";
import { SERVER_PORT, PATHS as APP_PATHS, CLAUDE_SCROLLBACK_ENV, AI_TOOLS } from "../../lib/constants.js";

const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;
// JS identifier cannot start with a digit, so plugin export name differs from the file mark
const OPENCODE_PLUGIN_MARK = "nineRemoteNotify";

// Backup of user's original env values, to restore on disable
const CLAUDE_ENV_BACKUP_FILE = path.join(APP_PATHS.STATE, "claudeEnvBackup.json");

const homeSub = (...p) => path.join(os.homedir(), ...p);
// Resolve config dir from env override (agent's own var) or fall back to ~/<fallback>
const envDir = (envVar, ...fallback) => {
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : homeSub(...fallback);
};

const PATHS = {
  claude: () => homeSub(".claude", "settings.json"),
  codex: () => homeSub(".codex", "config.toml"),
  gemini: () => homeSub(".gemini", "settings.json"),
  opencode: () => homeSub(".config", "opencode", "plugin", `${OPENCODE_PLUGIN_MARK}.js`),
  grok: () => path.join(envDir("GROK_HOME", ".grok"), "hooks", "9remote.json"),
  cursor: () => homeSub(".cursor", "hooks.json"),
  antigravity: () => homeSub(".gemini", "config", "hooks.json"),
  kiro: () => path.join(envDir("KIRO_HOME", ".kiro"), "agents", "9remote.json"),
  copilot: () => path.join(envDir("COPILOT_HOME", ".copilot"), "config.json"),
  codebuddy: () => path.join(envDir("CODEBUDDY_CONFIG_DIR", ".codebuddy"), "settings.json"),
  factory: () => homeSub(".factory", "settings.json"),
  qoder: () => path.join(envDir("QODER_CONFIG_DIR", ".qoder"), "settings.json"),
  rovodev: () => homeSub(".rovodev", "config.yml"),
  hermes: () => path.join(envDir("HERMES_HOME", ".hermes"), "config.yaml"),
  amp: () => homeSub(".config", "amp", "plugins", "9remote.ts"),
  pi: () => path.join(envDir("PI_CODING_AGENT_DIR", ".pi", "agent"), "extensions", "9remote.ts"),
};

// Binary name on PATH used to detect whether a tool is installed
const BINARIES = {
  claude: "claude", codex: "codex", gemini: "gemini", opencode: "opencode",
  grok: "grok", cursor: "cursor-agent", antigravity: "agy", kiro: "kiro-cli",
  copilot: "copilot", codebuddy: "codebuddy", factory: "droid", qoder: "qodercli",
  rovodev: "acli", hermes: "hermes", amp: "amp", pi: "pi",
};

const buildCurlCmd = (type, tool) =>
  `command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 "${NOTIFY_URL}?type=${type}&sessionId=$NINE_REMOTE_SESSION_ID&tool=${tool}" > /dev/null 2>&1 & true`;

// Legacy config-dir fallback for the original four tools (binary-on-PATH is the primary check)
const TOOL_DIRS = {
  claude: () => homeSub(".claude"),
  codex: () => homeSub(".codex"),
  gemini: () => homeSub(".gemini"),
  opencode: () => [homeSub(".config", "opencode"), homeSub(".opencode")],
};

// Timeout unit differs per agent: some nested-JSON hooks want seconds, Claude-style want ms
const SEC = (ms) => Math.ceil(ms / 1000);
const STOP_MS = 5000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// YAML double-quote escape for a shell command value
const yq = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Replace (or append) a marker-delimited block in a text config file. MVP: assumes 9remote owns its block.
function upsertBlock(filePath, begin, end, block) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  content = content.replace(new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, "g"), "");
  if (content.length && !content.endsWith("\n")) content += "\n";
  content += `${block}\n`;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function removeBlock(filePath, begin, end) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, content.replace(new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, "g"), ""), "utf8");
}

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
    Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: notifyCmd }] }],
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

// Nested "hooks"-object JSON (Claude-style). Owns its own event keys; merges next to user entries.
// events: { <eventKey>: "stop" | "notification" }, timeoutFn: (ms) => number
function makeNestedJsonHook(tool, events, timeoutFn) {
  const marker = `9remote-${tool}`;
  const buildEntry = (type) => ({ hooks: [{ type: "command", command: buildCurlCmd(type, tool), timeout: timeoutFn(STOP_MS) }] });
  const isOwn = (grp) => grp?.hooks?.some((h) => typeof h.command === "string" && h.command.includes(`&tool=${tool}`));
  return {
    enable(filePath, extra) {
      const settings = readJsonFile(filePath);
      const hooks = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((g) => !isOwn(g)), buildEntry(type)];
      }
      settings.hooks = hooks;
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath, extra) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((g) => !isOwn(g));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath) {
      const s = readJsonFile(filePath);
      return Object.keys(events).some((k) => (s.hooks?.[k] || []).some(isOwn));
    },
    marker,
  };
}

// Grok — nested JSON, native Notification, timeout in seconds
const grokHook = makeNestedJsonHook("grok", { Stop: "stop", Notification: "notification" }, SEC);
function enableGrokHook() { return grokHook.enable(PATHS.grok()); }
function disableGrokHook() { return grokHook.disable(PATHS.grok()); }

// Copilot / CodeBuddy / Factory / Qoder — nested JSON, PreToolUse = needs-input, timeout in ms.
// These emit Notification as an idle signal (would double the Stop), so we bind only Stop + PreToolUse.
const nestedInputEvents = { Stop: "stop", PreToolUse: "notification" };
const copilotHook = makeNestedJsonHook("copilot", nestedInputEvents, (ms) => ms);
const codebuddyHook = makeNestedJsonHook("codebuddy", nestedInputEvents, (ms) => ms);
const factoryHook = makeNestedJsonHook("factory", nestedInputEvents, (ms) => ms);
const qoderHook = makeNestedJsonHook("qoder", nestedInputEvents, (ms) => ms);
function enableCopilotHook() { return copilotHook.enable(PATHS.copilot()); }
function disableCopilotHook() { return copilotHook.disable(PATHS.copilot()); }
function enableCodebuddyHook() { return codebuddyHook.enable(PATHS.codebuddy()); }
function disableCodebuddyHook() { return codebuddyHook.disable(PATHS.codebuddy()); }
function enableFactoryHook() { return factoryHook.enable(PATHS.factory()); }
function disableFactoryHook() { return factoryHook.disable(PATHS.factory()); }
function enableQoderHook() { return qoderHook.enable(PATHS.qoder()); }
function disableQoderHook() { return qoderHook.disable(PATHS.qoder()); }

// Cursor — flat JSON, no timeout field, needs `version:1`; no native Notification → beforeShellExecution
function enableCursorHook() {
  const filePath = PATHS.cursor();
  const settings = readJsonFile(filePath);
  const isOwn = (e) => typeof e.command === "string" && e.command.includes("&tool=cursor");
  const hooks = { ...(settings.hooks || {}) };
  hooks.stop = [...(hooks.stop || []).filter((e) => !isOwn(e)), { command: buildCurlCmd("stop", "cursor") }];
  hooks.beforeShellExecution = [...(hooks.beforeShellExecution || []).filter((e) => !isOwn(e)), { command: buildCurlCmd("notification", "cursor") }];
  settings.hooks = hooks;
  settings.version = settings.version || 1;
  writeJsonFile(filePath, settings);
  return { success: true };
}
function disableCursorHook() {
  const filePath = PATHS.cursor();
  const settings = readJsonFile(filePath);
  const isOwn = (e) => typeof e.command === "string" && e.command.includes("&tool=cursor");
  if (settings.hooks) {
    for (const key of ["stop", "beforeShellExecution"]) {
      settings.hooks[key] = (settings.hooks[key] || []).filter((e) => !isOwn(e));
      if (settings.hooks[key].length === 0) delete settings.hooks[key];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeJsonFile(filePath, settings);
  return { success: true };
}

// Antigravity — no "hooks" wrapper; all entries live under a named group; timeout in seconds
const ANTIGRAVITY_GROUP = "9remote";
function enableAntigravityHook() {
  const filePath = PATHS.antigravity();
  const settings = readJsonFile(filePath);
  settings[ANTIGRAVITY_GROUP] = {
    Stop: [{ type: "command", command: buildCurlCmd("stop", "antigravity"), timeout: SEC(STOP_MS) }],
    Notification: [{ type: "command", command: buildCurlCmd("notification", "antigravity"), timeout: SEC(STOP_MS) }],
  };
  writeJsonFile(filePath, settings);
  return { success: true };
}
function disableAntigravityHook() {
  const filePath = PATHS.antigravity();
  const settings = readJsonFile(filePath);
  delete settings[ANTIGRAVITY_GROUP];
  writeJsonFile(filePath, settings);
  return { success: true };
}

// Kiro — custom agent definition; hooks only fire under `kiro-cli chat --agent 9remote`. timeout_ms in ms.
function enableKiroHook() {
  const filePath = PATHS.kiro();
  const settings = readJsonFile(filePath);
  settings.name = settings.name || "9remote";
  settings.description = settings.description || "9Remote notification hooks for Kiro CLI.";
  if (!Array.isArray(settings.tools)) settings.tools = ["*"];
  settings.hooks = {
    ...(settings.hooks || {}),
    stop: [{ command: buildCurlCmd("stop", "kiro"), timeout_ms: STOP_MS }],
    preToolUse: [{ command: buildCurlCmd("notification", "kiro"), timeout_ms: STOP_MS }],
  };
  writeJsonFile(filePath, settings);
  return { success: true };
}
function disableKiroHook() {
  const filePath = PATHS.kiro();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return { success: true };
}

// Rovo Dev — YAML, marker-delimited block. stop=on_complete/on_error, notification=on_tool_permission
const ROVO_BEGIN = "  # 9remote hooks begin";
const ROVO_END = "  # 9remote hooks end";
function buildRovoBlock() {
  const item = (name, type) => `    - name: ${name}\n      commands:\n        - command: ${yq(buildCurlCmd(type, "rovodev"))}`;
  return [ROVO_BEGIN, item("on_complete", "stop"), item("on_error", "stop"), item("on_tool_permission", "notification"), ROVO_END].join("\n");
}
function enableRovodevHook() {
  const filePath = PATHS.rovodev();
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  content = content.replace(new RegExp(`${escapeRe(ROVO_BEGIN)}[\\s\\S]*?${escapeRe(ROVO_END)}\\n?`, "g"), "");
  // Ensure eventHooks.events container exists, then insert our block under it
  if (!/^eventHooks:/m.test(content)) {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += "eventHooks:\n  events:\n";
  } else if (!/^\s+events:/m.test(content)) {
    content = content.replace(/^eventHooks:.*$/m, (m) => `${m}\n  events:`);
  }
  content = content.replace(/^(\s*)events:.*$/m, (m) => `${m}\n${buildRovoBlock()}`);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { success: true };
}
function disableRovodevHook() {
  removeBlock(PATHS.rovodev(), ROVO_BEGIN, ROVO_END);
  return { success: true };
}

// Hermes — YAML block + a shell-hooks allowlist file (both must match byte-for-byte)
const HERMES_BEGIN = "# 9remote hooks begin";
const HERMES_END = "# 9remote hooks end";
const hermesAllowlistPath = () => path.join(path.dirname(PATHS.hermes()), "shell-hooks-allowlist.json");
const HERMES_HOOKS = [{ event: "post_llm_call", type: "stop" }, { event: "pre_approval_request", type: "notification" }];
function enableHermesHook() {
  const filePath = PATHS.hermes();
  const block = [HERMES_BEGIN, "hooks:",
    ...HERMES_HOOKS.map(({ event, type }) => `  ${event}:\n    - command: ${yq(buildCurlCmd(type, "hermes"))}\n      timeout: 5`),
    HERMES_END].join("\n");
  upsertBlock(filePath, HERMES_BEGIN, HERMES_END, block);
  // Allowlist: Hermes blocks shell hooks that aren't pre-approved
  const alPath = hermesAllowlistPath();
  const al = readJsonFile(alPath);
  const others = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
  al.approvals = [...others, ...HERMES_HOOKS.map(({ event, type }) => ({ event, command: buildCurlCmd(type, "hermes"), approved_at: "2020-01-01T00:00:00Z" }))];
  writeJsonFile(alPath, al);
  return { success: true };
}
function disableHermesHook() {
  removeBlock(PATHS.hermes(), HERMES_BEGIN, HERMES_END);
  const alPath = hermesAllowlistPath();
  if (fs.existsSync(alPath)) {
    const al = readJsonFile(alPath);
    al.approvals = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
    if (al.approvals.length) writeJsonFile(alPath, al);
    else fs.unlinkSync(alPath);
  }
  return { success: true };
}

// Amp / Pi — TS plugin files (no declarative command hooks). No permission event → stop-only.
function buildTsPlugin(tool, api, endEvent) {
  return `// 9Remote ${tool} notify plugin (auto-generated)
function post(type) {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  const url = ${JSON.stringify(NOTIFY_URL)} + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=${tool}";
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch (_) {}
}
export default function (${api}) {
  ${api}.on(${JSON.stringify(endEvent)}, async () => post("stop"));
}
`;
}
function enableAmpHook() {
  const filePath = PATHS.amp();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buildTsPlugin("amp", "amp", "agent.end"), "utf8");
  return { success: true };
}
function disableAmpHook() {
  if (fs.existsSync(PATHS.amp())) fs.unlinkSync(PATHS.amp());
  return { success: true };
}
function enablePiHook() {
  const filePath = PATHS.pi();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buildTsPlugin("pi", "pi", "agent_end"), "utf8");
  return { success: true };
}
function disablePiHook() {
  if (fs.existsSync(PATHS.pi())) fs.unlinkSync(PATHS.pi());
  return { success: true };
}

// Status checks — file-content markers keyed by "&tool=<name>" written into every hook command
function fileHas(filePath, needle) {
  try { return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(needle); } catch { return false; }
}

function isToolHookEnabled(tool) {
  switch (tool) {
    case "claude": {
      const s = readJsonFile(PATHS.claude());
      return !!(s.hooks?.Stop || s.hooks?.Notification);
    }
    case "codex":
      return fileHas(PATHS.codex(), "# 9Remote notification");
    case "gemini": {
      const s = readJsonFile(PATHS.gemini());
      return !!(s.hooks?.AfterAgent || s.hooks?.Notification);
    }
    case "opencode":
    case "amp":
    case "pi":
      return fs.existsSync(PATHS[tool]());
    case "kiro":
    case "antigravity":
    case "cursor":
    case "grok":
    case "copilot":
    case "codebuddy":
    case "factory":
    case "qoder":
    case "rovodev":
    case "hermes":
      return fileHas(PATHS[tool](), `&tool=${tool}`);
    default: return false;
  }
}

// Whether a binary is resolvable on PATH (how the tool announces it's installed)
function binaryOnPath(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return dirs.some((d) => exts.some((ext) => {
    try { return fs.existsSync(path.join(d, bin + ext)); } catch { return false; }
  }));
}

function isToolInstalled(tool) {
  const bin = BINARIES[tool];
  if (bin && binaryOnPath(bin)) return true;
  // Fallback: legacy config-dir presence for the original four tools
  const dirs = TOOL_DIRS[tool]?.();
  if (!dirs) return false;
  return (Array.isArray(dirs) ? dirs : [dirs]).some((d) => fs.existsSync(d));
}

const ENABLERS = {
  claude: enableClaudeHook, codex: enableCodexHook, gemini: enableGeminiHook, opencode: enableOpencodeHook,
  grok: enableGrokHook, cursor: enableCursorHook, antigravity: enableAntigravityHook, kiro: enableKiroHook,
  copilot: enableCopilotHook, codebuddy: enableCodebuddyHook, factory: enableFactoryHook, qoder: enableQoderHook,
  rovodev: enableRovodevHook, hermes: enableHermesHook, amp: enableAmpHook, pi: enablePiHook,
};
const DISABLERS = {
  claude: disableClaudeHook, codex: disableCodexHook, gemini: disableGeminiHook, opencode: disableOpencodeHook,
  grok: disableGrokHook, cursor: disableCursorHook, antigravity: disableAntigravityHook, kiro: disableKiroHook,
  copilot: disableCopilotHook, codebuddy: disableCodebuddyHook, factory: disableFactoryHook, qoder: disableQoderHook,
  rovodev: disableRovodevHook, hermes: disableHermesHook, amp: disableAmpHook, pi: disablePiHook,
};

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
