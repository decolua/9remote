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

// Chat is sans where the terminal is mono; Inter reads smaller at equal px
// (lower x-height, lighter strokes), so the pane sizes one step up to match.
export const AI_FONT_SIZE_BOOST = 1;
export const AI_FONT_SIZE_BOOST_MOBILE = 2;

// Dot grid painted on the AI pane. Alpha is a share of the palette foreground, so
// it stays subtle on both light and dark palettes.
export const AI_DOT_GRID = { alpha: 7, size: 18 };

// Prompts offered on an empty conversation. Diagnostics (/doctor) and resuming are
// not here — they are commands, not a way to start a chat.
export const STARTER_PROMPTS = Object.freeze([
  "Explain this project's structure",
  "What changed recently in this repo?",
  "! git status"
]);

// Skipping a gate is a denial, not a made-up answer: the CLI tells the model the user
// declined and the turn carries on. Typing a new message while a card is open is the
// same signal — the user moved on, and leaving the CLI waiting for an answer nobody
// will give is what used to wedge the chat until the watchdog killed it.
export const SKIP_BEHAVIOR = "deny";
export const SKIP_MESSAGE = "User skipped this request";

// How long an answer waits for the host's ok before the card admits it did not arrive.
// A carrier can take the emit and still lose the bytes (a zombie RTC data channel), and
// an answer nobody was told about is the same stuck chat as one never sent.
export const RESOLVE_ACK_TIMEOUT_MS = 5000;
