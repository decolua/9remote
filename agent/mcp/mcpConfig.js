// Register/unregister the agent's MCP endpoint in each AI CLI's own config file.
// One entry per CLI in CLIENTS; adding a CLI means adding an entry, nothing else.
import fs from "fs";
import path from "path";
import os from "os";
import { SERVER_PORT, MCP } from "../lib/constants.js";
import { getMcpToken } from "../lib/mcpToken.js";
import { readSettings, writeSettings } from "../lib/settings.js";
import { writeJsonAtomic } from "../lib/atomicFile.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("mcp");
const URL = `http://127.0.0.1:${SERVER_PORT}${MCP.PATH}`;
const NAME = MCP.SERVER_NAME;
const AUTH = () => `Bearer ${getMcpToken()}`;
const homeSub = (...p) => path.join(os.homedir(), ...p);

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return {}; }
}

// Walk a dotted path, creating the objects on the way. The servers map is nested
// at different depths per CLI ("mcpServers" vs "mcp.servers"), so the path is data.
function containerAt(config, keyPath, create) {
  let node = config;
  for (const part of keyPath) {
    if (!node[part]) {
      if (!create) return null;
      node[part] = {};
    }
    node = node[part];
  }
  return node;
}

// Prune the containers this entry was the last occupant of, deepest first, so an
// empty "mcp": {} is not left behind.
function pruneEmpty(config, keyPath) {
  for (let depth = keyPath.length; depth > 0; depth--) {
    const parent = containerAt(config, keyPath.slice(0, depth - 1), false);
    const key = keyPath[depth - 1];
    if (!parent?.[key] || Object.keys(parent[key]).length) return;
    delete parent[key];
  }
}

// A CLI keeping its servers under a JSON key (Claude Code: top-level mcpServers).
// The file holds the user's whole config, so it is edited in place, never rewritten.
// keyPath may be a function when the CLI's own shape depends on what is already there.
function jsonClient({ file, keyPath = ["mcpServers"], entry, mode = 0o600 }) {
  const pathFor = (config) => (typeof keyPath === "function" ? keyPath(config) : keyPath);
  return {
    enable() {
      const filePath = file();
      const config = readJson(filePath);
      containerAt(config, pathFor(config), true)[NAME] = entry();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeJsonAtomic(filePath, config, { mode });
    },
    disable() {
      const filePath = file();
      if (!fs.existsSync(filePath)) return;
      const config = readJson(filePath);
      const keys = pathFor(config);
      const container = containerAt(config, keys, false);
      if (!container?.[NAME]) return;
      delete container[NAME];
      pruneEmpty(config, keys);
      writeJsonAtomic(filePath, config, { mode });
    },
    isEnabled() {
      const config = readJson(file());
      return !!containerAt(config, pathFor(config), false)?.[NAME];
    },
  };
}

// A CLI keeping its config in a text format we do not parse (TOML/YAML): own a
// marker-delimited block and leave every other line untouched. Same trick the
// notify hooks use for codex/hermes/rovodev.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function blockClient({ file, lines }) {
  const begin = `# 9Remote MCP (${NAME})`;
  const end = "# /9Remote MCP";
  // begin carries parentheses — unescaped they read as a regex group and match nothing
  const blockRe = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, "g");
  const strip = (filePath) => {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8").replace(blockRe, "");
  };
  return {
    enable() {
      const filePath = file();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let content = strip(filePath);
      if (content.length && !content.endsWith("\n")) content += "\n";
      fs.writeFileSync(filePath, `${content}${[begin, ...lines(), end].join("\n")}\n`, "utf8");
    },
    disable() {
      const filePath = file();
      if (fs.existsSync(filePath)) fs.writeFileSync(filePath, strip(filePath), "utf8");
    },
    isEnabled() {
      const filePath = file();
      return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(begin);
    },
  };
}

// One entry per CLI that can reach the endpoint. Both shapes below carry the token
// as a static header — an env var would have to exist in whatever shell launched the CLI.
const CLIENTS = {
  claude: jsonClient({
    file: () => homeSub(".claude.json"),
    entry: () => ({ type: "http", url: URL, headers: { Authorization: AUTH() } }),
  }),
  // opencode v1 keys servers straight off `mcp`; v2 nests them under `mcp.servers`.
  // The existing file says which, so an upgrade is followed rather than fought.
  opencode: jsonClient({
    file: () => homeSub(".config", "opencode", "opencode.json"),
    keyPath: (config) => (config?.mcp?.servers ? ["mcp", "servers"] : ["mcp"]),
    entry: () => ({ type: "remote", url: URL, enabled: true, headers: { Authorization: AUTH() } }),
    // Not a secrets-only file: it is the user's own opencode config
    mode: 0o644,
  }),
  codex: blockClient({
    file: () => homeSub(".codex", "config.toml"),
    lines: () => [
      `[mcp_servers."${NAME}"]`,
      `url = ${JSON.stringify(URL)}`,
      `[mcp_servers."${NAME}".http_headers]`,
      `Authorization = ${JSON.stringify(AUTH())}`,
    ],
  }),
};

export const MCP_CLIENTS = Object.keys(CLIENTS);

// Settings is the single source of truth; the CLI config files only mirror it. Cached
// because every MCP request checks it, and setMcpEnabled is the only writer in this
// process — a settings.json edited by hand is picked up on the next agent start.
let cached = null;
export function isMcpEnabled() {
  if (cached === null) {
    const saved = readSettings().artifactEnabled;
    cached = saved === undefined ? MCP.DEFAULT_ENABLED : !!saved;
  }
  return cached;
}

// Best-effort per CLI: one unwritable config must not stop the others.
function applyTo(tool, enabled) {
  const client = CLIENTS[tool];
  if (!client) return;
  try {
    if (enabled) client.enable();
    else client.disable();
  } catch (e) {
    logger.warn(`${enabled ? "enable" : "disable"} ${tool} failed: ${e.message}`);
  }
}

function applyToAll(enabled) {
  for (const tool of MCP_CLIENTS) applyTo(tool, enabled);
}

// Write the setting through to every CLI at once. Returns the value that stuck.
export function setMcpEnabled(enabled) {
  const next = !!enabled;
  writeSettings({ artifactEnabled: next });
  cached = next;
  applyToAll(next);
  logger.info(`artifact MCP ${next ? "enabled" : "disabled"} for ${MCP_CLIENTS.join(", ")}`);
  return next;
}

// Startup reconciliation: a fresh install has no entry yet, and a config edited by
// hand (or carrying an older token) would otherwise keep failing auth.
export function syncMcpConfig() {
  const enabled = isMcpEnabled();
  applyToAll(enabled);
  return enabled;
}
