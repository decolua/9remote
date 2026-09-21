// Model options discovered dynamically from CLI configurations and local catalogs.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import { PATHS } from "../../lib/constants.js";
import { writeJsonAtomic } from "../../lib/atomicFile.js";

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
    const updated = {
      ...existing,
      ...(patch.model !== undefined ? { model: patch.model } : null),
      ...(patch.effort !== undefined ? { effort: patch.effort } : null)
    };
    current[engine] = updated;
    writeJsonAtomic(AI_PREFERENCES_FILE, current);
  } catch {}
}

// Resolve default model from preferences or CLI configuration.
export function resolveDefaultModel(engine) {
  const saved = readAiPreferences()[engine]?.model;
  if (typeof saved === "string" && saved) return saved;

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

// Antigravity model ids come straight from `agy models` (no JSON mode).
export function listAntigravityModelOptions() {
  let out = "";
  try {
    const res = spawnSync("agy", ["models"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) out = res.stdout || "";
  } catch {
    return [];
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((id) => ({
    id,
    label: id,
    short: id,
    desc: "",
    efforts: [],
    defaultEffort: ""
  }));
}
