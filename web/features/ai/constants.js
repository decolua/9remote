// AI Feature constants for 9remote
// Engine-specific config (models, modes, tools, commands) lives in registry.js —
// add an engine class there, never a branch here.
import { listEngines, listAiUiOptions } from "./registry.js";

// Re-exported so callers can keep importing engine data from one place.
export { getEngineConfig, getEngineInfo, listEngines, listAiUiOptions } from "./registry.js";

// Engine id → display metadata, derived from the registry so the two can't drift.
// Kept as a plain object for the existing `ENGINE_INFO[engine]` call sites.
export const ENGINE_INFO = Object.fromEntries(listEngines().map((m) => [m.id, m]));

// "New tab" entries for the AI UIs, derived from the registry.
export const AI_UI_OPTIONS = listAiUiOptions();
