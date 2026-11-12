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

// Chat canvas — 9love's three-layer recipe (wallpaper tile, pool of light, tilted
// 15deg band) painted on 9remote's own neutral greys instead of 9love's warm paper.
export const AI_CANVAS = {
  // 9remote's own neutral ground — the app is a dark-first tool, so the chat canvas
  // takes its greys from --bg / --surface instead of 9love's warm paper. The centre
  // leans very slightly warm so the pool of light does not read as a grey smudge.
  light: { base: "#F7F5F2", center: "#FFFFFF", edge: "#EAE6E1" },
  dark: { base: "#141414", center: "#1F1D1C", edge: "#0C0C0C" },
  poolSize: "95% 80%",
  poolAt: "46% 38%",
  poolFalloff: 68,
  tiltDeg: 105,
  bandStart: 42,
  bandEnd: 58
};

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

// A prompt that neither acked nor errored within this window fell into a dead
// carrier — surface it as a resendable error instead of silent loss (#48). A false
// "lost" is cheap now: a late ack withdraws the bar and the host dedupes a resend.
export const PROMPT_ACK_TIMEOUT_MS = 5000;
