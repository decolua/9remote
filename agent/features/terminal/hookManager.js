// AI Tool Hook Management — registry-driven.
// One entry per tool in TOOL_REGISTRY; enable/disable dispatch by `kind`.
// Event types: "working" | "blocked" | "done" (mapped to 4-state by statusManager).
// To add a tool: append a TOOL_REGISTRY entry + its PATHS/BINARIES/TOOL_DIRS slot.
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
  codexScript: () => homeSub(".codex", "9remote-notify.sh"),
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

// ─── Kind: json-nested (Claude-style hooks object) ──────────────────────────
// events: { <eventKey>: type }, matchers: { <eventKey>: matcher }, timeoutFn, extra(settings)
function makeNestedJsonHook(tool, events, timeoutFn, { matchers = {}, extra } = {}) {
  const buildEntry = (key, type) => ({
    hooks: [{ type: "command", command: buildCurlCmd(type, tool), timeout: timeoutFn(STOP_MS) }],
    ...(matchers[key] != null ? { matcher: matchers[key] } : {}),
  });
  const isOwn = (grp) => grp?.hooks?.some((h) => typeof h.command === "string" && h.command.includes(`&tool=${tool}`));
  return {
    enable(filePath) {
      const settings = readJsonFile(filePath);
      const hooks = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((g) => !isOwn(g)), buildEntry(key, type)];
      }
      settings.hooks = hooks;
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath) {
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
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isOwn));
    },
  };
}

// ─── Kind: json-flat (Cursor) — flat hooks.{event}:[{command}], no timeout ───
function makeFlatJsonHook(tool, events, { extra } = {}) {
  const isOwn = (e) => typeof e?.command === "string" && e.command.includes(`&tool=${tool}`);
  const hook = {
    enable(filePath) {
      const settings = readJsonFile(filePath);
      const hooks = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((e) => !isOwn(e)), { command: buildCurlCmd(type, tool) }];
      }
      settings.hooks = hooks;
      if (extra) extra(settings);
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((e) => !isOwn(e));
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
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isOwn));
    },
  };
  return hook;
}

// ─── Kind: json-group (Antigravity) — entries under a named root group, SEC timeout ─
function makeGroupJsonHook(tool, groupName, events) {
  const hook = {
    enable(filePath) {
      const settings = readJsonFile(filePath);
      const group = {};
      for (const [key, type] of Object.entries(events)) {
        group[key] = [{ type: "command", command: buildCurlCmd(type, tool), timeout: SEC(STOP_MS) }];
      }
      settings[groupName] = group;
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath) {
      const settings = readJsonFile(filePath);
      delete settings[groupName];
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath) {
      const s = readJsonFile(filePath);
      return !!s[groupName];
    },
  };
  return hook;
}

// ─── Kind: json-agent (Kiro) — custom agent definition, timeout_ms ──────────
function makeAgentJsonHook(tool, events, { name, description } = {}) {
  const isOwn = (e) => typeof e?.command === "string" && e.command.includes(`&tool=${tool}`);
  const hook = {
    enable(filePath) {
      const settings = readJsonFile(filePath);
      settings.name = settings.name || name || "9remote";
      settings.description = settings.description || description || `9Remote hooks for ${tool} CLI.`;
      if (!Array.isArray(settings.tools)) settings.tools = ["*"];
      const hooks = { ...(settings.hooks || {}) };
      for (const [key, type] of Object.entries(events)) {
        hooks[key] = [...(hooks[key] || []).filter((e) => !isOwn(e)), { command: buildCurlCmd(type, tool), timeout_ms: STOP_MS }];
      }
      settings.hooks = hooks;
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    disable(filePath) {
      if (!fs.existsSync(filePath)) return { success: true };
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(events)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((e) => !isOwn(e));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeJsonFile(filePath, settings);
      return { success: true };
    },
    isEnabled(filePath) {
      const s = readJsonFile(filePath);
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isOwn));
    },
  };
  return hook;
}

// ─── Kind: yaml-block (Hermes / Rovo Dev) — marker-delimited YAML block ─────
// items: [{ event, type }] → produces a YAML list under a `hooks:` block
function makeYamlBlockHook(tool, { begin, end, items }) {
  const buildBlock = () => {
    const lines = [begin, "hooks:",
      ...items.map(({ event, type }) => `  ${event}:\n    - command: ${yq(buildCurlCmd(type, tool))}\n      timeout: 5`),
      end];
    return lines.join("\n");
  };
  return {
    enable(filePath) { upsertBlock(filePath, begin, end, buildBlock()); return { success: true }; },
    disable(filePath) { removeBlock(filePath, begin, end); return { success: true }; },
    isEnabled(filePath) { return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(begin); },
  };
}

// ─── Kind: toml-codex — single notify slot; wrapper script parses stdin JSON ─
// Codex `notify` receives JSON on stdin with a `type` field; map it to our 3 types.
const CODEX_BLOCK_RE = /# 9Remote notification\nnotify\s*=.*\n?/g;
const CODEX_SAVED_PREFIX = "# 9Remote-saved: ";
const CODEX_ACTIVE_NOTIFY_RE = /^notify\s*=\s*(\[[^\n]*\])\s*$/m;
function splitCodexHead(content) {
  const idx = content.search(/^\[/m);
  return idx === -1 ? [content, ""] : [content.slice(0, idx), content.slice(idx)];
}
function buildCodexNotifyScript() {
  // Map codex event → 9remote type. agent-turn-complete→done, reasoning/streaming→working, input→blocked.
  return `#!/bin/sh
# 9Remote codex notify wrapper — maps codex events to 9remote status types.
input=$(cat 2>/dev/null || echo "")
t="done"
case "$input" in
  *agent-turn-complete*|*turn-complete*) t="done" ;;
  *input-request*|*input_required*|*approval*) t="blocked" ;;
  *agent-reasoning*|*agent-message*|*agent-streaming*|*reasoning*) t="working" ;;
esac
command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 "${NOTIFY_URL}?type=$t&sessionId=$NINE_REMOTE_SESSION_ID&tool=codex" > /dev/null 2>&1
`;
}
const codexHook = {
  enable() {
    const filePath = PATHS.codex();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Write the wrapper script
    const scriptPath = PATHS.codexScript();
    fs.writeFileSync(scriptPath, buildCodexNotifyScript(), "utf8");
    try { fs.chmodSync(scriptPath, 0o755); } catch {}

    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    content = content.replace(CODEX_BLOCK_RE, "");
    let [head, rest] = splitCodexHead(content);

    // Preserve the user's existing top-level notify (commented) so we don't lose it on disable
    const match = head.match(CODEX_ACTIVE_NOTIFY_RE);
    if (match) head = head.replace(CODEX_ACTIVE_NOTIFY_RE, `${CODEX_SAVED_PREFIX}$&`);

    const block = `# 9Remote notification\nnotify = ["bash", ${JSON.stringify(scriptPath)}, "9remote"]\n`;
    if (head.length && !head.endsWith("\n")) head += "\n";
    fs.writeFileSync(filePath, head + block + rest, "utf8");
    return { success: true };
  },
  disable() {
    const filePath = PATHS.codex();
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, "utf8");
      content = content.replace(CODEX_BLOCK_RE, "");
      content = content.replace(new RegExp(`^${CODEX_SAVED_PREFIX}(notify\\s*=.*)$`, "m"), "$1");
      let [head, rest] = splitCodexHead(content);
      if (rest && head.length && !head.endsWith("\n")) head += "\n";
      fs.writeFileSync(filePath, head + rest, "utf8");
    }
    const scriptPath = PATHS.codexScript();
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    return { success: true };
  },
  isEnabled() {
    return fs.existsSync(PATHS.codex()) && fs.readFileSync(PATHS.codex(), "utf8").includes("# 9Remote notification");
  },
};

// ─── Kind: js-plugin-opencode — JS plugin emitting per-event fetch ──────────
function buildOpencodePlugin() {
  return `// 9Remote OpenCode status plugin (auto-generated)
const base = ${JSON.stringify(NOTIFY_URL)};
const post = (type) => {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  const url = base + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=opencode";
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch {}
};
export const ${OPENCODE_PLUGIN_MARK} = async () => ({
  "chat.message": async () => post("working"),
  "tool.execute.before": async () => post("working"),
  "tool.execute.after": async () => post("working"),
  event: async ({ event }) => {
    const t = event?.type;
    if (!t) return;
    if (t === "session.idle") return post("done");
    if (t === "permission.asked" || t === "question.asked" || t === "session.error") return post("blocked");
    if (t === "session.compacted" || t === "permission.replied" || t === "question.replied") return post("working");
  },
});
`;
}
const opencodeHook = {
  enable() {
    const filePath = PATHS.opencode();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buildOpencodePlugin(), "utf8");
    return { success: true };
  },
  disable() {
    const filePath = PATHS.opencode();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  },
  isEnabled() { return fs.existsSync(PATHS.opencode()); },
};

// ─── Kind: ts-plugin (Amp / Pi) — TS plugin with start + end events ─────────
function buildTsPlugin(tool, api, startEvent, endEvent) {
  return `// 9Remote ${tool} status plugin (auto-generated)
function post(type) {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  const url = ${JSON.stringify(NOTIFY_URL)} + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=${tool}";
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch (_) {}
}
export default function (${api}) {
  ${api}.on(${JSON.stringify(startEvent)}, async () => post("working"));
  ${api}.on(${JSON.stringify(endEvent)}, async () => post("done"));
}
`;
}

// ─── Registry ───────────────────────────────────────────────────────────────
// Each entry builds its hook object via the kind factory. Add a tool → add an entry.
const HERMES_BEGIN = "# 9remote hooks begin";
const HERMES_END = "# 9remote hooks end";
const ROVO_BEGIN = "  # 9remote hooks begin";
const ROVO_END = "  # 9remote hooks end";

const TOOL_REGISTRY = {
  claude: makeNestedJsonHook("claude",
    { UserPromptSubmit: "working", PostToolUse: "working", Stop: "done", Notification: "blocked" },
    (ms) => ms,
    { matchers: { Notification: "permission_prompt" }, extra: applyClaudeEnv }),
  codex: codexHook,
  gemini: makeNestedJsonHook("gemini",
    { BeforeAgent: "working", PreToolUse: "working", PostToolUse: "working", AfterAgent: "done", Notification: "blocked" },
    (ms) => ms),
  opencode: opencodeHook,
  grok: makeNestedJsonHook("grok",
    { UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working", Stop: "done", Notification: "blocked" },
    SEC),
  cursor: makeFlatJsonHook("cursor",
    { stop: "done", beforeShellExecution: "blocked", beforeToolCall: "working" },
    { extra: (s) => { s.version = s.version || 1; } }),
  antigravity: makeGroupJsonHook("antigravity", "9remote",
    { UserPromptSubmit: "working", PreToolUse: "working", Stop: "done", Notification: "blocked" }),
  kiro: makeAgentJsonHook("kiro",
    { UserPromptSubmit: "working", PostToolUse: "working", preToolUse: "blocked", stop: "done" }),
  copilot: makeNestedJsonHook("copilot",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  codebuddy: makeNestedJsonHook("codebuddy",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  factory: makeNestedJsonHook("factory",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  qoder: makeNestedJsonHook("qoder",
    { UserPromptSubmit: "working", PostToolUse: "working", PreToolUse: "blocked", Stop: "done" },
    (ms) => ms),
  rovodev: makeYamlBlockHook("rovodev", {
    begin: ROVO_BEGIN, end: ROVO_END,
    items: [
      { event: "on_complete", type: "done" },
      { event: "on_error", type: "done" },
      { event: "on_tool_permission", type: "blocked" },
      { event: "on_message", type: "working" },
      { event: "on_tool_start", type: "working" },
    ],
  }),
  // Hermes: YAML block + companion shell-hooks-allowlist.json (dynamic path next to config).
  hermes: (() => {
    const base = makeYamlBlockHook("hermes", {
      begin: HERMES_BEGIN, end: HERMES_END,
      items: [
        { event: "pre_llm_call", type: "working" },
        { event: "pre_tool_call", type: "working" },
        { event: "post_tool_call", type: "working" },
        { event: "pre_approval_request", type: "blocked" },
        { event: "post_llm_call", type: "done" },
      ],
    });
    const allowlistPath = () => path.join(path.dirname(PATHS.hermes()), "shell-hooks-allowlist.json");
    return {
      enable: () => {
        const res = base.enable(PATHS.hermes());
        const al = readJsonFile(allowlistPath());
        const others = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
        al.approvals = [...others, ...[
          { event: "pre_llm_call", type: "working" },
          { event: "pre_tool_call", type: "working" },
          { event: "post_tool_call", type: "working" },
          { event: "pre_approval_request", type: "blocked" },
          { event: "post_llm_call", type: "done" },
        ].map(({ event, type }) => ({ event, command: buildCurlCmd(type, "hermes"), approved_at: "2020-01-01T00:00:00Z" }))];
        writeJsonFile(allowlistPath(), al);
        return res;
      },
      disable: () => {
        const res = base.disable(PATHS.hermes());
        const alPath = allowlistPath();
        if (fs.existsSync(alPath)) {
          const al = readJsonFile(alPath);
          al.approvals = (al.approvals || []).filter((a) => !(typeof a.command === "string" && a.command.includes("&tool=hermes")));
          if (al.approvals.length) writeJsonFile(alPath, al);
          else fs.unlinkSync(alPath);
        }
        return res;
      },
      isEnabled: () => base.isEnabled(PATHS.hermes()),
    };
  })(),
  amp: {
    enable() {
      const filePath = PATHS.amp();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buildTsPlugin("amp", "amp", "agent.start", "agent.end"), "utf8");
      return { success: true };
    },
    disable() { if (fs.existsSync(PATHS.amp())) fs.unlinkSync(PATHS.amp()); return { success: true }; },
    isEnabled() { return fs.existsSync(PATHS.amp()); },
  },
  pi: {
    enable() {
      const filePath = PATHS.pi();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buildTsPlugin("pi", "pi", "agent_start", "agent_end"), "utf8");
      return { success: true };
    },
    disable() { if (fs.existsSync(PATHS.pi())) fs.unlinkSync(PATHS.pi()); return { success: true }; },
    isEnabled() { return fs.existsSync(PATHS.pi()); },
  },
};

// ─── Public API ─────────────────────────────────────────────────────────────
export const SUPPORTED_TOOLS = AI_TOOLS;

export function enableToolHook(tool) {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return { success: false, error: "Unknown tool" };
  try {
    if (tool === "codex" || tool === "opencode" || tool === "amp" || tool === "pi") return hook.enable();
    return hook.enable(PATHS[tool]());
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function disableToolHook(tool) {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return { success: false, error: "Unknown tool" };
  try {
    if (tool === "codex" || tool === "opencode" || tool === "amp" || tool === "pi") return hook.disable();
    return hook.disable(PATHS[tool]());
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Reports enabled only when EVERY event the registry declares is present.
// (A tool with a legacy partial install — e.g. only Stop/Notification, no working events — is NOT fully enabled.)
function isToolHookEnabled(tool) {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return false;
  if (tool === "codex" || tool === "opencode" || tool === "amp" || tool === "pi") return hook.isEnabled();
  return hook.isEnabled(PATHS[tool]());
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
  const dirs = TOOL_DIRS[tool]?.();
  if (!dirs) return false;
  return (Array.isArray(dirs) ? dirs : [dirs]).some((d) => fs.existsSync(d));
}

// Auto-enable hooks for every installed AI tool on startup. enable() is idempotent — it adds
// any missing events without duplicating existing ones — so we always run it. This matters when
// a new event (e.g. working) is added to the registry after an older agent already wrote Stop/Notification.
export function autoEnableInstalledHooks() {
  const result = {};
  for (const tool of SUPPORTED_TOOLS) {
    if (!isToolInstalled(tool)) continue;
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
