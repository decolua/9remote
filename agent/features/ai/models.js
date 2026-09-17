// Selectable models, read from the host's CLI rather than a baked-in list: ids like
// `glm/glm-5.3-flash[1m]` or `cx/gpt-5.6-luna` only exist on a machine whose config
// points at a gateway, and a hardcoded list drifts the moment they change one.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";

// Each env key names one slot the CLI offers. `[1m]` suffixes are kept verbatim —
// they select the 1M-context variant and must survive back to `--model`.
const SLOTS = [
  ["ANTHROPIC_CUSTOM_MODEL_OPTION", "Custom"],
  ["ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable"],
  ["ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus"],
  ["ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet"],
  ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku"],
];

// The CLI's own aliases, used only when the host configures no custom models.
const FALLBACK = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
];

// Codex renders its own model catalog (display names, reasoning tiers) as JSON. The
// command is local and returns in ~20ms — no auth or network needed.
const CODEX_CATALOG_TIMEOUT_MS = 5000;
// `opencode models` lists the host's providers; a few seconds on a cold start.
const OPENCODE_CATALOG_TIMEOUT_MS = 10000;

function readClaudeSettings() {
  try {
    const file = path.join(os.homedir(), ".claude", "settings.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // No settings file, or invalid JSON — callers fall back to the CLI's own default.
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
  // The custom option carries a human name of its own
  if (options[0]?.label === "Custom" && typeof env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === "string") {
    options[0].label = env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME.trim() || "Custom";
  }

  return options.length > 0 ? options : FALLBACK;
}

/**
 * The model ids the host's own config names, when codex runs on a provider the host
 * declared itself (top-level `model_provider` → a `[model_providers.*]` block). The
 * CLI's catalog is OpenAI's and through such a gateway every one of its slugs 404s —
 * the config's ids are the only picks that provider is known to answer. Null means
 * the built-in provider is in play and the catalog applies.
 */
function configuredCodexModels() {
  let text = "";
  try {
    text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
  // Sections in file order; the text before the first is the top level — the only part
  // a plain `codex` run picks up (same rule as resolveDefaultModel).
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
    // A profile naming another provider belongs to that one, not the one running.
    const sectionProvider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(section)?.[1] || provider;
    if (sectionProvider !== provider) continue;
    push(/^\s*model\s*=\s*"([^"]+)"/m.exec(section)?.[1]);
  }
  // A provider with no model named anywhere falls back to the catalog — an empty
  // picker is worse than one that lists the built-ins.
  return ids.length > 0 ? ids : null;
}

/**
 * Models the host's codex CLI offers, each with the reasoning tiers it supports.
 * Hidden catalog entries (auto-review, oss) are dropped — they are not user picks.
 */
export function listCodexModelOptions() {
  const configured = configuredCodexModels();
  if (configured) {
    // No tiers: the catalog does not know a gateway id, and the composer already
    // falls back to codex's own effort ladder for exactly that case.
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
      // How full the client may fill the window before the CLI compacts. `effective_
      // context_window_percent` is the CLI's own headroom, so it is what it enforces.
      contextWindow: Math.round((m.context_window || 0) * ((m.effective_context_window_percent ?? 100) / 100)) || 0
    }));
}

/**
 * `opencode models --verbose` prints an id, then that model's JSON on the following
 * lines — its `variants` are the reasoning levels `--variant` accepts. The plain form
 * lists ids only, which is why the picker used to offer levels a model rejects.
 */
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
    // Collect the pretty-printed object that follows the id.
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
      // A model whose block failed to parse still belongs in the list.
    }
    const raw = model?.variants || {};
    options.push({
      id,
      label: id,
      short: id,
      // The variant names are what `--variant` takes; the value is always reasoningEffort.
      efforts: Object.keys(raw),
      // opencode stores its pick as "default" — a marker for the model's own default,
      // not a level, so it is never the fallback.
      defaultEffort: raw.medium ? "medium" : Object.keys(raw).find((k) => k !== "default") || ""
    });
  }
  return options;
}

/**
 * The model a brand-new chat starts with, read from each CLI's own config — the id
 * lives only on the host (gateway aliases, per-machine picks) so nothing may be baked
 * in. Empty string means "let the CLI decide".
 */
export function resolveDefaultModel(engine) {
  if (engine === "claude") {
    // Claude resolves `sonnet`-style aliases through the same env slots the picker lists.
    const settings = readClaudeSettings();
    const alias = typeof settings.model === "string" ? settings.model : "";
    if (!alias) return "";
    const slot = SLOTS.find(([key, label]) => label.toLowerCase() === alias.toLowerCase());
    return (slot && settings.env?.[slot[0]]) || alias;
  }

  if (engine === "codex") {
    // config.toml is small and hand-edited; only the top-level `model` key matters.
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
    // opencode keeps the last model used in its own state file — that is the one a
    // fresh `run` picks up when no `-m` is passed.
    try {
      const file = path.join(os.homedir(), ".local", "state", "opencode", "model.json");
      const recent = JSON.parse(fs.readFileSync(file, "utf8")).recent || [];
      const { providerID, modelID } = recent[0] || {};
      if (!providerID || !modelID) return "";
      const id = `${providerID}/${modelID}`;
      // A stale pick (provider dropped since) would 404 — the catalog has the last word.
      const catalog = listOpencodeModelOptions();
      return catalog.length === 0 || catalog.some((m) => m.id === id) ? id : "";
    } catch {
      return "";
    }
  }

  return "";
}

/**
 * The reasoning effort a brand-new chat runs with, read from the CLI's own config the
 * same way the model is. Empty string means "let the CLI decide" — which is only
 * correct when the CLI's config says nothing either.
 *
 * Without this the pane showed no effort until the user picked one, because the value
 * only ever arrived from `setOptions`. The CLI was running `medium` the whole time.
 */
export function resolveDefaultEffort(engine) {
  if (engine === "claude") {
    const level = readClaudeSettings().effortLevel;
    return typeof level === "string" ? level.trim() : "";
  }

  if (engine === "codex") {
    // `model_reasoning_effort` at the top level, before any [section]. The per-profile
    // copies further down are not what a plain `codex exec` picks up.
    try {
      const text = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
      const top = text.split(/^\s*\[/m)[0] || "";
      return /^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] || "";
    } catch {
      return "";
    }
  }

  // opencode keeps its variant in `--variant`, which it stores nowhere readable.
  return "";
}
