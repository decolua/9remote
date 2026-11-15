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

// Pictures ride only the last few turns: a reopened chat must not pull megabytes of
// screenshots nobody is looking at.
export const RECENT_IMAGE_TURNS = 5;
// Thumbnail reads are downscaled on the host — a 1600px JPEG behind a 56px thumb is
// bandwidth nobody sees.
export const TURN_THUMB_MAX_DIM = 320;

// Chat canvas — 9love's three-layer recipe (wallpaper tile, pool of light, tilted
// 15deg band) painted on 9remote's own neutral greys instead of 9love's warm paper.
export const AI_CANVAS = {
  // 9remote's own neutral ground — the app is a dark-first tool, so the chat canvas
  // takes its greys from --bg / --surface instead of 9love's warm paper. The centre
  // leans very slightly warm so the pool of light does not read as a grey smudge.
  light: {
    base: "#F1EFEA",
    center: "#FBFAF7",
    edge: "#E7E3DC",
    // Faint ambient pools: light glass needs colour behind it to refract, and pure
    // white over pure white was the glare.
    glow: "radial-gradient(70% 55% at 18% 12%, rgba(230,138,110,0.06), transparent 62%), radial-gradient(60% 50% at 84% 86%, rgba(120,140,180,0.04), transparent 66%), ",
    glowSize: "100% 100%, 100% 100%, ",
    glowRepeat: "no-repeat, no-repeat, "
  },
  dark: { base: "#141414", center: "#1F1D1C", edge: "#0C0C0C", glow: "", glowSize: "", glowRepeat: "" },
  poolSize: "95% 80%",
  poolAt: "46% 38%",
  poolFalloff: 68,
  tiltDeg: 105,
  bandStart: 42,
  bandEnd: 58
};

// Three background layers as inline style — wallpaper tile, pool of light, tilted
// band. The AI pane and the mobile session list share one recipe.
export function chatCanvasStyle(theme) {
  const canvas = AI_CANVAS[theme === "light" ? "light" : "dark"];
  return {
    backgroundColor: canvas.base,
    backgroundImage: `${canvas.glow}var(--ai-wallpaper), radial-gradient(${AI_CANVAS.poolSize} at ${AI_CANVAS.poolAt}, ${canvas.center}, transparent ${AI_CANVAS.poolFalloff}%), linear-gradient(${AI_CANVAS.tiltDeg}deg, ${canvas.edge}, ${canvas.base} ${AI_CANVAS.bandStart}%, ${canvas.base} ${AI_CANVAS.bandEnd}%, ${canvas.edge})`,
    backgroundSize: `${canvas.glowSize}var(--ai-wallpaper-size), 100% 100%, 100% 100%`,
    backgroundRepeat: `${canvas.glowRepeat}repeat, no-repeat, no-repeat`
  };
}

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

// An ack only proves the host accepted the prompt; the turn is alive when its
// user_message arrives (the host emits it before the ack). No echo past this
// budget means the prompt died between ack and turn — offer Resend again.
export const PROMPT_ECHO_TIMEOUT_MS = 3000;
