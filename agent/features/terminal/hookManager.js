// Registry-driven hook management mapping tool events to working/blocked/done.
import os from "os";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { SERVER_PORT, PATHS as APP_PATHS, CLAUDE_SCROLLBACK_ENV, AI_TOOLS } from "../../lib/constants.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";
import { hookSessionIdKeys } from "./agentCatalog.js";

const NOTIFY_URL = `http://localhost:${SERVER_PORT}/api/notify`;
// JS identifier cannot start with a digit, so plugin export name differs from the file mark
const OPENCODE_PLUGIN_MARK = "nineRemoteNotify";

// Backup of user's original env values, to restore on disable
const CLAUDE_ENV_BACKUP_FILE = path.join(APP_PATHS.STATE, "claudeEnvBackup.json");

const homeSub = (...p) => path.join(os.homedir(), ...p);
const envDir = (envVar, ...fallback) => {
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : homeSub(...fallback);
};

const PATHS = {
  claude: () => homeSub(".claude", "settings.json"),
  codex: () => homeSub(".codex", "config.toml"),
  codexHooks: () => homeSub(".codex", "hooks.json"),
  codexScript: () => homeSub(".codex", "9remote-notify.sh"),
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

const BINARIES = {
  claude: "claude", codex: "codex", opencode: "opencode",
  grok: "grok", cursor: "cursor-agent", antigravity: "agy", kiro: "kiro-cli",
  copilot: "copilot", codebuddy: "codebuddy", factory: "droid", qoder: "qodercli",
  rovodev: "acli", hermes: "hermes", amp: "amp", pi: "pi",
};

// Capture conversation ID from stdin JSON to support relaunching later.
const buildCurlCmd = (type, tool, { sessionId = false } = {}) => {
  const key = sessionId ? hookSessionIdKeys(tool)[0] : null;
  const prefix = key ? `csid=$(cat 2>/dev/null | sed -n 's/.*"${key}" *: *"\\([^"]*\\)".*/\\1/p'); ` : "";
  const extra = key ? "&csid=$csid" : "";
  return `${prefix}command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 "${NOTIFY_URL}?type=${type}&sessionId=$NINE_REMOTE_SESSION_ID${extra}&tool=${tool}" > /dev/null 2>&1 & true`;
};

// Legacy config-dir fallback for the original four tools (binary-on-PATH is the primary check)
const TOOL_DIRS = {
  claude: () => homeSub(".claude"),
  codex: () => homeSub(".codex"),
  opencode: () => [homeSub(".config", "opencode"), homeSub(".opencode")],
};

// Timeout unit differs per agent: some nested-JSON hooks want seconds, Claude-style want ms
const SEC = (ms) => Math.ceil(ms / 1000);
const STOP_MS = 5000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const yq = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

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
  // Atomic write to prevent corrupting third-party tool settings.
  writeJsonAtomic(filePath, data, { mode: 0o644 });
}

function applyClaudeEnv(settings) {
  const backup = {};
  const env = settings.env || {};
  for (const k of Object.keys(CLAUDE_SCROLLBACK_ENV)) backup[k] = env[k] ?? null;
  writeJsonFile(CLAUDE_ENV_BACKUP_FILE, backup);
  settings.env = { ...env, ...CLAUDE_SCROLLBACK_ENV };
}

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
function makeNestedJsonHook(tool, events, timeoutFn, { matchers = {}, extra, sessionId = false } = {}) {
  const buildEntry = (key, type) => ({
    hooks: [{ type: "command", command: buildCurlCmd(type, tool, { sessionId }), timeout: timeoutFn(STOP_MS) }],
    ...(matchers[key] != null ? { matcher: matchers[key] } : {}),
  });
  const isOwn = (grp) => grp?.hooks?.some((h) => typeof h.command === "string" && h.command.includes(`&tool=${tool}`));
  const isCurrent = (grp) => grp?.hooks?.some((h) =>
    typeof h.command === "string" && h.command.includes(`&tool=${tool}`) && (!sessionId || h.command.includes("&csid=")));
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
      return Object.keys(events).every((k) => (s.hooks?.[k] || []).some(isCurrent));
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

// ─── Kind: hooks-json-codex — codex 0.154's own hook file, plus the trust it needs ──
// Codex hooks require positional trusted sha256 hashes in config.toml.
const CODEX_HOOK_EVENTS = {
  UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
  Stop: "done", PermissionRequest: "blocked",
};
const CODEX_EVENT_KEY = (ev) => ev.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const CODEX_EVENT_OF_KEY = Object.fromEntries(
  Object.keys(CODEX_HOOK_EVENTS).map((ev) => [CODEX_EVENT_KEY(ev), ev])
);
const CODEX_STATE_HEAD = /^\[hooks\.state\."(?<key>[^"]+)"\]$/m;
const CODEX_APP_SERVER_TIMEOUT_MS = 15000;

function codexHookList(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve([]);
    }
    let buf = "";
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(() => finish([]), CODEX_APP_SERVER_TIMEOUT_MS);
    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: {} }) + "\n");
          continue;
        }
        if (msg.id !== 2) continue;
        const rows = [];
        for (const cwd of msg.result?.data || []) {
          for (const h of cwd.hooks || []) {
            if (h.currentHash) rows.push({ key: h.key, hash: h.currentHash });
          }
        }
        finish(rows);
        return;
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "9remote", version: "1" } } }) + "\n");
  });
}

// Codex returns "sha256:<hex>"; stored verbatim to prevent double-prefixing.
const codexHashValue = (hash) => (/^sha256:/.test(hash) ? hash : `sha256:${hash}`);

function codexHandlersIn(filePath) {
  const hooks = readJsonFile(filePath).hooks || {};
  const out = [];
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      (group?.hooks || []).forEach((h, hi) => {
        if (typeof h?.command !== "string") return;
        out.push({ key: `${filePath}:${CODEX_EVENT_KEY(ev)}:${gi}:${hi}`, event: ev, command: h.command });
      });
    });
  }
  return out;
}

// Targeted line replacement for trusted_hash entries to preserve user settings.
function upsertCodexTrust(filePath, entries) {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = content.split("\n");
  const out = [];
  const remaining = new Map();
  for (const e of entries) remaining.set(e.key, codexHashValue(e.hash));
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CODEX_STATE_HEAD);
    const next = lines[i + 1] || "";
    if (!match || !/^\s*trusted_hash\s*=/.test(next)) { out.push(lines[i]); continue; }
    const hash = remaining.get(match.groups.key);
    if (hash === undefined) { out.push(lines[i], next); i++; continue; }
    remaining.delete(match.groups.key);
    out.push(lines[i], `trusted_hash = "${hash}"`);
    i++;
  }
  for (const [key, hash] of remaining) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`[hooks.state."${key}"]`, `trusted_hash = "${hash}"`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, out.join("\n"), "utf8");
}

// Query codex app-server to compute and trust hook hashes in config.toml.
export async function reconcileCodexHookTrust({ run = codexHookList, bin = BINARIES.codex } = {}) {
  const hooksPath = PATHS.codexHooks();
  const reported = await run(bin);
  const byKey = new Map(reported.map((r) => [r.key, r.hash]));
  const ours = codexHandlersIn(hooksPath).filter((h) => h.command.includes("&tool=codex"));
  const entries = [];
  const missing = [];
  for (const h of ours) {
    const hash = byKey.get(h.key);
    if (hash) entries.push({ key: h.key, hash });
    else missing.push(h.key);
  }
  if (!reported.length) return { entries: [], missing, skipped: true };
  upsertCodexTrust(PATHS.codex(), entries);
  return { entries, missing, skipped: false };
}

// Drop trust entries for handlers occupied before removal to avoid shifting foreign keys.
function dropCodexTrust(filePath, goneKeys) {
  if (!fs.existsSync(filePath) || !goneKeys.size) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CODEX_STATE_HEAD);
    const next = lines[i + 1] || "";
    if (!match || !/^\s*trusted_hash\s*=/.test(next)) { out.push(lines[i]); continue; }
    if (!goneKeys.has(match.groups.key)) { out.push(lines[i], next); i++; continue; }
    i++;
    if (out[out.length - 1] === "") out.pop();
  }
  fs.writeFileSync(filePath, out.join("\n"), "utf8");
}

// Remove obsolete legacy notify configuration.
const CODEX_LEGACY_BLOCK_RE = /# 9Remote notification\nnotify\s*=.*\n?/g;
const CODEX_LEGACY_SAVED_RE = /^# 9Remote-saved: (notify\s*=.*)$/m;

function dropLegacyCodexNotify() {
  const scriptPath = PATHS.codexScript();
  const filePath = PATHS.codex();
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf8");
    let next = content.replace(CODEX_LEGACY_BLOCK_RE, "");
    const saved = next.match(CODEX_LEGACY_SAVED_RE);
    if (saved && !saved[1].includes(scriptPath)) next = next.replace(CODEX_LEGACY_SAVED_RE, "$1");
    else if (saved) next = next.replace(/^# 9Remote-saved: notify\s*=.*\n?/m, "");
    next = next.replace(/^notify\s*=\s*\[[^\n]*9remote-notify\.sh[^\n]*\]\s*\n?/m, "");
    if (next !== content) fs.writeFileSync(filePath, next, "utf8");
  }
  if (fs.existsSync(scriptPath)) { try { fs.unlinkSync(scriptPath); } catch {} }
}

const codexHook = {
  enable() {
    const filePath = PATHS.codexHooks();
    const settings = readJsonFile(filePath);
    const hooks = { ...(settings.hooks || {}) };
    for (const [key, type] of Object.entries(CODEX_HOOK_EVENTS)) {
      hooks[key] = [...(hooks[key] || []).filter((g) => !isOwnCodexGroup(g)), buildCodexGroup(type)];
    }
    settings.hooks = hooks;
    writeJsonFile(filePath, settings);
    dropLegacyCodexNotify();
    return { success: true };
  },
  disable() {
    const filePath = PATHS.codexHooks();
    const goneKeys = new Set(codexHandlersIn(filePath).filter((h) => h.command.includes("&tool=codex")).map((h) => h.key));
    if (fs.existsSync(filePath)) {
      const settings = readJsonFile(filePath);
      if (settings.hooks) {
        for (const key of Object.keys(CODEX_HOOK_EVENTS)) {
          settings.hooks[key] = (settings.hooks[key] || []).filter((g) => !isOwnCodexGroup(g));
          if (settings.hooks[key].length === 0) delete settings.hooks[key];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeJsonFile(filePath, settings);
    }
    dropCodexTrust(PATHS.codex(), goneKeys);
    return { success: true };
  },
  isEnabled() {
    const hooks = readJsonFile(PATHS.codexHooks()).hooks || {};
    return Object.keys(CODEX_HOOK_EVENTS).every((k) => (hooks[k] || []).some(isOwnCodexGroup));
  },
};

function isOwnCodexGroup(group) {
  return (group?.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("&tool=codex"));
}

function buildCodexGroup(type) {
  return { hooks: [{ type: "command", command: buildCurlCmd(type, "codex", { sessionId: true }), timeout: SEC(STOP_MS) }] };
}


// ─── Kind: js-plugin-opencode — JS plugin emitting per-event fetch ──────────
function buildOpencodePlugin() {
  return `// 9Remote OpenCode status plugin (auto-generated)
const base = ${JSON.stringify(NOTIFY_URL)};
const post = (type, conv) => {
  const sid = process.env.NINE_REMOTE_SESSION_ID || "";
  if (!sid) return;
  let url = base + "?type=" + type + "&sessionId=" + encodeURIComponent(sid) + "&tool=opencode";
  if (conv) url += "&sessionID=" + encodeURIComponent(conv);
  try { fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch {}
};
export const ${OPENCODE_PLUGIN_MARK} = async () => ({
  "chat.message": async (input) => post("working", input?.message?.sessionID),
  "tool.execute.before": async (input) => post("working", input?.sessionID),
  "tool.execute.after": async (input) => post("working", input?.sessionID),
  event: async ({ event }) => {
    const t = event?.type;
    if (!t) return;
    const conv = event?.properties?.sessionID || event?.properties?.info?.sessionID;
    if (t === "session.idle") return post("done", conv);
    if (t === "permission.asked" || t === "question.asked" || t === "session.error") return post("blocked", conv);
    if (t === "session.compacted" || t === "permission.replied" || t === "question.replied") return post("working", conv);
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
  // A plugin written before it reported conversation ids is stale, not enabled —
  // otherwise the UI never re-runs enable() and the id never starts arriving.
  isEnabled() {
    const filePath = PATHS.opencode();
    return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes("&sessionID=");
  },
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
    { UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
      Stop: "done", PermissionRequest: "blocked", Notification: "blocked" },
    (ms) => ms,
    { matchers: { Notification: "permission_prompt" }, extra: applyClaudeEnv, sessionId: true }),
  codex: codexHook,
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
  }}

function isToolHookEnabled(tool) {
  const hook = TOOL_REGISTRY[tool];
  if (!hook) return false;
  if (tool === "codex" || tool === "opencode" || tool === "amp" || tool === "pi") return hook.isEnabled();
  return hook.isEnabled(PATHS[tool]());
}

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

// Idempotently enable hooks for all installed AI tools on startup.
export function autoEnableInstalledHooks() {
  const result = {};
  for (const tool of SUPPORTED_TOOLS) {
    if (!isToolInstalled(tool)) continue;
    try {
      const r = enableToolHook(tool);
      result[tool] = r.success && !r.untrusted?.length;
    } catch { result[tool] = false; }
  }
  return result;
}

export async function reconcileCodexTrust() {
  if (!isToolInstalled("codex")) return null;
  try {
    const { missing } = await reconcileCodexHookTrust();
    if (missing.length) console.warn(`⚠️  codex hooks written but not trusted: ${missing.length} — run codex and trust them`);
    return missing.length ? { untrusted: missing.length } : { untrusted: 0 };
  } catch (e) {
    console.warn(`⚠️  codex hook trust failed: ${e.message}`);
    return { error: e.message };
  }
}

export function getHookStatus() {
  const status = {};
  for (const tool of SUPPORTED_TOOLS) {
    status[tool] = { installed: isToolInstalled(tool), enabled: isToolHookEnabled(tool) };
  }
  return status;
}

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
