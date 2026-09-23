// Model options discovered dynamically from CLI configurations and local catalogs.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PATHS } from "../../lib/constants.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";
import { getExtendedEnv } from "./adapters/env.js";

const require = createRequire(import.meta.url);

// Env slots for Claude models; [1m] context suffix is preserved.
const SLOTS = [
  ["ANTHROPIC_CUSTOM_MODEL_OPTION", "Custom"],
  ["ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"],
  ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"],
  ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"],
  ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"],
];

// Fallback aliases when no custom models are configured.
const FALLBACK = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
];

const CODEX_CATALOG_TIMEOUT_MS = 5000;
const OPENCODE_CATALOG_TIMEOUT_MS = 10000;

function readClaudeSettings() {
  try {
    const file = path.join(os.homedir(), ".claude", "settings.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function listModelOptions() {
  const env = readClaudeSettings().env || {};
  const options = [];
  const seen = new Set();
  for (const [key, label] of SLOTS) {
    const id = typeof env[key] === "string" ? env[key].trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label, short: id });
  }
  if (options[0]?.label === "Custom" && typeof env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === "string") {
    options[0].label = env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME.trim() || "Custom";
  }

  return options.length > 0 ? options : FALLBACK;
}

// Read custom model IDs from ~/.codex/config.toml when a custom provider is configured.
function configuredCodexModels() {
  let text = "";
  try {
    text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
  const sections = text.split(/^\s*\[/m);
  const top = sections[0] || "";
  const provider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
  if (!provider || !text.includes(`[model_providers.${provider}]`)) return null;

  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  push(/^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1]);
  for (const section of sections.slice(1)) {
    const header = (section.slice(0, section.indexOf("]")) || "").trim();
    if (!/^profiles\.[^.\]]+$/.test(header)) continue;
    const sectionProvider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(section)?.[1] || provider;
    if (sectionProvider !== provider) continue;
    push(/^\s*model\s*=\s*"([^"]+)"/m.exec(section)?.[1]);
  }
  return ids.length > 0 ? ids : null;
}

// List Codex model options from config or `codex debug models` catalog.
export function listCodexModelOptions() {
  const configured = configuredCodexModels();
  if (configured) {
    return configured.map((id) => ({ id, label: id, short: id, desc: "Configured in ~/.codex/config.toml", efforts: [], defaultEffort: "" }));
  }
  let res;
  try {
    res = spawnSync("codex", ["debug", "models"], {
      encoding: "utf8",
      timeout: CODEX_CATALOG_TIMEOUT_MS
    });
  } catch {
    return [];
  }
  if (res.error || res.status !== 0) return [];

  let models = [];
  try {
    models = JSON.parse(res.stdout || "{}").models || [];
  } catch {
    return [];
  }

  return models
    .filter((m) => m?.slug && m.visibility === "list")
    .map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      short: m.display_name || m.slug,
      desc: m.description || "",
      defaultEffort: m.default_reasoning_level || "",
      efforts: (m.supported_reasoning_levels || []).map((r) => r.effort),
      // Effective context window accounting for CLI headroom percentage.
      contextWindow: Math.round((m.context_window || 0) * ((m.effective_context_window_percent ?? 100) / 100)) || 0
    }));
}

// List OpenCode models and supported reasoning variants via `opencode models --verbose`.
export function listOpencodeModelOptions() {
  let out = "";
  try {
    const res = spawnSync("opencode", ["models", "--verbose"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }

  const options = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(id) || lines[i + 1]?.trim() !== "{") continue;
    let json = "", depth = 0;
    for (let j = i + 1; j < lines.length; j++) {
      json += lines[j];
      for (const ch of lines[j]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0) { i = j; break; }
    }
    let model = null;
    try {
      model = JSON.parse(json);
    } catch {
    }
    const raw = model?.variants || {};
    options.push({
      id,
      label: id,
      short: id,
      efforts: Object.keys(raw),
      // 'default' is an OpenCode marker, not a reasoning level; fallback to medium.
      defaultEffort: raw.medium ? "medium" : Object.keys(raw).find((k) => k !== "default") || ""
    });
  }
  return options;
}

const AI_PREFERENCES_FILE = path.join(PATHS.STATE, "aiPreferences.json");

export function readAiPreferences() {
  try {
    return JSON.parse(fs.readFileSync(AI_PREFERENCES_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

export function saveAiPreference(engine, patch) {
  if (!engine || !patch || typeof patch !== "object") return;
  try {
    const current = readAiPreferences();
    const existing = current[engine] || {};
    const cleanModel = patch.model !== undefined
      ? String(patch.model || "").split("\t")[0].trim()
      : undefined;
    const updated = {
      ...existing,
      ...(cleanModel !== undefined ? { model: cleanModel } : null),
      ...(patch.effort !== undefined ? { effort: patch.effort } : null)
    };
    current[engine] = updated;
    writeJsonAtomic(AI_PREFERENCES_FILE, current);
  } catch {}
}

// Resolve default model from preferences or CLI configuration.
export function resolveDefaultModel(engine) {
  const saved = readAiPreferences()[engine]?.model;
  if (typeof saved === "string" && saved) return saved.split("\t")[0].trim();

  if (engine === "claude") {
    const settings = readClaudeSettings();
    const alias = typeof settings.model === "string" ? settings.model : "";
    if (!alias) return "";
    const slot = SLOTS.find(([key, label]) => label.toLowerCase() === alias.toLowerCase());
    return (slot && settings.env?.[slot[0]]) || alias;
  }

  if (engine === "codex") {
    try {
      const file = path.join(os.homedir(), ".codex", "config.toml");
      const text = fs.readFileSync(file, "utf8");
      const top = text.split(/^\s*\[/m)[0] || "";
      return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    } catch {
      return "";
    }
  }

  if (engine === "opencode") {
    // Read last used model from OpenCode state file.
    try {
      const file = path.join(os.homedir(), ".local", "state", "opencode", "model.json");
      const recent = JSON.parse(fs.readFileSync(file, "utf8")).recent || [];
      const { providerID, modelID } = recent[0] || {};
      if (!providerID || !modelID) return "";
      const id = `${providerID}/${modelID}`;
      const catalog = listOpencodeModelOptions();
      return catalog.length === 0 || catalog.some((m) => m.id === id) ? id : "";
    } catch {
      return "";
    }
  }

  if (engine === "omp") {
    try {
      const file = path.join(os.homedir(), ".omp", "agent", "config.yml");
      const text = fs.readFileSync(file, "utf8");
      const match = /^\s*default:\s*([^\s\n]+)/m.exec(text);
      if (match?.[1]) return match[1].trim();
    } catch {
      return "";
    }
  }

  if (engine === "devin") {
    // The CLI's own record: the model its newest session actually ran — never a canned id.
    try {
      const { DatabaseSync } = require("node:sqlite");
      const dbPath = path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
      if (!fs.existsSync(dbPath)) return "";
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare(
          "SELECT model FROM sessions WHERE model IS NOT NULL AND model != '' ORDER BY last_activity_at DESC LIMIT 1"
        ).get();
        return row?.model || "";
      } finally {
        db.close();
      }
    } catch {
      return "";
    }
  }

  return "";
}

// Resolve default reasoning effort from preferences or CLI configuration.
export function resolveDefaultEffort(engine) {
  const saved = readAiPreferences()[engine]?.effort;
  if (typeof saved === "string" && saved) return saved;

  if (engine === "claude") {
    const level = readClaudeSettings().effortLevel;
    return typeof level === "string" ? level.trim() : "";
  }

  if (engine === "codex") {
    try {
      const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
      const top = text.split(/^\s*\[/m)[0] || "";
      return /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    } catch {
      return "";
    }
  }

  if (engine === "hermes") {
    // Scoped to the agent: block — a loose match catches reasoning_effort under
    // other sections (summaries, image description) that this engine never reads.
    return /^\s*reasoning_effort:\s*["']?([\w-]+)/m.exec(yamlBlock(readHermesConfig(), "agent"))?.[1] || "";
  }

  return "";
}

// The serve server's own model list (GET /api/model): the only source that
// carries limit.context, so the pane gets a real context-window denominator.
// Falls back to [] (caller keeps the CLI spawn path as last resort).
export async function listOpencodeModelOptionsFromServer() {
  try {
    const { ensureServer } = await import("./opencodeServer.js");
    const base = await ensureServer();
    const res = await fetch(`${base}/api/model`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const body = await res.json();
    const models = Array.isArray(body?.data) ? body.data : [];
    return models
      .filter((m) => m?.id && m?.providerID)
      .map((m) => {
        const variants = Object.keys(m.variants || {});
        const efforts = variants.filter((v) => v !== "default");
        return {
          id: `${m.providerID}/${m.id}`,
          label: m.name || `${m.providerID}/${m.id}`,
          short: m.name || m.id,
          desc: "",
          efforts,
          // 'default' is a marker, not a reasoning level; medium is OpenCode's own middle.
          defaultEffort: m.variants?.medium ? "medium" : efforts[0] || "",
          contextWindow: m.limit?.context || 0
        };
      });
  } catch {
    return [];
  }
}

// Antigravity model ids come straight from `agy models` (format: `<id>\t<label>`).
export function listAntigravityModelOptions() {
  let out = "";
  try {
    const res = spawnSync("agy", ["models"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  return out.split("\n")
    .map((l) => l.trim())
    .filter((l) => Boolean(l) && !/^fetching/i.test(l))
    .map((line) => {
      const [id, ...rest] = line.split("\t");
      const cleanId = (id || "").trim();
      const label = rest.join(" ").trim() || cleanId;
      return {
        id: cleanId,
        label,
        short: label,
        desc: "",
        efforts: [],
        defaultEffort: ""
      };
    })
    .filter((m) => Boolean(m.id));
}

// List OMP models via `omp models --json`; omp already filters to providers with auth.
export function listOmpModelOptions() {
  let out = "";
  try {
    const res = spawnSync("omp", ["models", "--json"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  let models = [];
  try {
    models = JSON.parse(out).models || [];
  } catch {
    return [];
  }
  return models
    .filter((m) => m?.id && m.provider)
    .map((m) => {
      const id = m.selector || `${m.provider}/${m.id}`;
      // 9router in TUI displays m.id (e.g. ag/claude-sonnet-4-6, bzl/...); others use m.name || m.id
      const displayLabel = m.provider === "9router" ? m.id : (m.name || m.id);
      return {
        id,
        provider: m.provider,
        label: displayLabel,
        short: displayLabel,
        desc: "",
        efforts: Array.isArray(m.thinking) ? m.thinking : [],
        defaultEffort: "",
        contextWindow: m.contextWindow || 0
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

// List Devin models via `devin models list --format json`: families carry the
// provider label, each variant (reasoning level baked into the uid) one option.
export function listDevinModelOptions() {
  let out = "";
  try {
    const res = spawnSync("devin", ["models", "list", "--format", "json"], {
      encoding: "utf8",
      env: getExtendedEnv(),
      timeout: OPENCODE_CATALOG_TIMEOUT_MS
    });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  let families = [];
  try {
    families = JSON.parse(out).families || [];
  } catch {
    return [];
  }
  const options = [];
  for (const family of families) {
    for (const v of family.variants || []) {
      if (!v.model_uid) continue;
      options.push({
        id: v.model_uid,
        provider: family.family_label || family.slug || "Devin",
        label: v.label || v.model_uid,
        short: v.label || v.model_uid,
        desc: v.cost_summary || "",
        efforts: [],
        defaultEffort: "",
        // The catalog carries no window; usage_update reports the live one.
        contextWindow: 0
      });
    }
  }
  return options.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

// Merge models matching OpenCode TUI structure:
// Recent at the top, followed by OpenCode Go and OpenCode Zen.
export async function listAllOpencodeModelOptions() {
  const byId = new Map();
  const recentIds = [];

  // 1. Read recent models from OpenCode state file
  try {
    const stateFile = path.join(os.homedir(), ".local", "state", "opencode", "model.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const r of state?.recent || []) {
      if (r?.providerID && r?.modelID) {
        recentIds.push(`${r.providerID}/${r.modelID}`);
      }
    }
  } catch {}

  // 2. Read CLI models (opencode models --verbose)
  for (const m of listOpencodeModelOptions()) {
    const provider = m.id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
    byId.set(m.id, {
      ...m,
      provider,
      label: m.label || m.id,
      short: m.short || m.id,
      desc: m.desc || "",
      contextWindow: m.contextWindow || 0
    });
  }

  // 3. Read server models (GET /api/model) carrying contextWindow and display names
  const serverModels = await listOpencodeModelOptionsFromServer();
  for (const m of serverModels) {
    const existing = byId.get(m.id);
    const provider = m.id.startsWith("opencode-go/") ? "opencode-go" : "opencode";
    byId.set(m.id, {
      ...existing,
      ...m,
      provider,
      label: m.label || existing?.label || m.id,
      short: m.short || existing?.short || m.id
    });
  }

  // 4. Attach recent info
  const all = Array.from(byId.values()).map((m) => {
    const recIdx = recentIds.indexOf(m.id);
    return {
      ...m,
      recent: recIdx >= 0,
      recentRank: recIdx >= 0 ? recIdx : 999
    };
  });

  return all;
}

// ── Hermes ──────────────────────────────────────────────────────────────────
// hermes_constants.py VALID_REASONING_EFFORTS (0.21.4); "none" disables thinking.
export const HERMES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const hermesConfigPath = () => path.join(os.homedir(), ".hermes", "config.yaml");
const readHermesConfig = () => {
  try { return fs.readFileSync(hermesConfigPath(), "utf8"); } catch { return ""; }
};

// Top-level `key:` block of a YAML file — a loose key match anywhere would catch
// the same name nested under another section.
function yamlBlock(text, key) {
  const m = new RegExp(`^${key}:\\s*$`, "m").exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = /^[A-Za-z_]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// The wire has no reasoning switch — config.yaml is the only door and it is read
// once per session build, so a change costs a config write + process recycle.
export function setHermesReasoningEffort(effort) {
  const file = hermesConfigPath();
  const text = fs.readFileSync(file, "utf8");
  const head = /^agent:[ \t]*$/m.exec(text);
  if (!head) throw new Error("No agent: block in ~/.hermes/config.yaml");
  const start = head.index + head[0].length;
  const rest = text.slice(start);
  const next = /^[A-Za-z_]/m.exec(rest);
  const end = next ? start + next.index : text.length;
  const block = text.slice(start, end);
  if (!/^[ \t]*reasoning_effort:/m.test(block)) throw new Error("No agent.reasoning_effort key in ~/.hermes/config.yaml");
  const patched = block.replace(/^([ \t]*reasoning_effort:\s*).*$/m, `$1${effort}`);
  fs.writeFileSync(file, text.slice(0, start) + patched + text.slice(end));
}

// The live catalog the running adapter absorbed from session/new — the connect ack
// serves it, so a reconnect never trades the full menu for the config fallback.
let hermesLiveCatalog = null;
export function setHermesLiveCatalog(options) {
  hermesLiveCatalog = Array.isArray(options) && options.length ? options : null;
}

export function listHermesModelOptions() {
  if (hermesLiveCatalog) return hermesLiveCatalog;
  const modelBlock = yamlBlock(readHermesConfig(), "model");
  const model = /^\s*default:\s*["']?([^"'\n]+)/m.exec(modelBlock)?.[1]?.trim() || "";
  if (!model) return [];
  const provider = /^\s*provider:\s*["']?([^"'\n]+)/m.exec(modelBlock)?.[1]?.trim() || "";
  // ids are "provider:model" on this wire (the picker's own encoding), so the
  // fallback row must match or a pick from it would 404 the session/set_model.
  const id = provider && !model.startsWith(`${provider}:`) ? `${provider}:${model}` : model;
  return [{ id, label: id, short: id, desc: "", efforts: [], defaultEffort: "", contextWindow: 0 }];
}
