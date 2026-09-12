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
 * Models the host's codex CLI offers, each with the reasoning tiers it supports.
 * Hidden catalog entries (auto-review, oss) are dropped — they are not user picks.
 */
export function listCodexModelOptions() {
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
      efforts: (m.supported_reasoning_levels || []).map((r) => r.effort)
    }));
}

/** `opencode models` prints one `provider/model` id per line. */
export function listOpencodeModelOptions() {
  let ids = [];
  try {
    const res = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: OPENCODE_CATALOG_TIMEOUT_MS });
    if (!res.error && res.status === 0) {
      ids = (res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    }
  } catch {
    return [];
  }
  return ids.map((id) => ({ id, label: id, short: id }));
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
