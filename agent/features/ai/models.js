// Selectable Claude models, read from the host's CLI config rather than a baked-in
// list: ids like `glm/glm-5.3-flash[1m]` only exist on a machine whose settings point
// at a gateway, and a hardcoded list drifts the moment they change one.
import fs from "fs";
import os from "os";
import path from "path";

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

export function listModelOptions() {
  let env = {};
  try {
    const file = path.join(os.homedir(), ".claude", "settings.json");
    env = JSON.parse(fs.readFileSync(file, "utf8")).env || {};
  } catch {
    // No settings file, or invalid JSON — the aliases are still valid choices.
  }

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
