// Bridges the screen parser into the live socket feed.
//
// The transcript answers "what was said"; the screen answers "what is happening right
// now" — the spinner verb, an open selector — before the CLI flushes anything to disk.
// This stays an indicator: the authoritative prompt card still comes from hook payloads.
import { parseScreen, applyScreenStream } from "./screenParser.js";
import { CLAUDE_PROFILE } from "./cliProfiles.js";
import { readScreen } from "../terminal/screenMirror.js";
import { broadcast } from "../../transport/broadcast.js";
import { EVENTS } from "./constants.js";

// Re-parsing on every frame would burn CPU for nothing — the snapshot is an indicator,
// not a log. One update per burst is plenty for a human.
const EMIT_THROTTLE_MS = 300;
const lastEmit = new Map();   // sessionId → ts

/**
 * Push a live snapshot for a session to all subscribed clients (throttled).
 * Called from the terminal output path — must never throw into it.
 */
export function emitLiveSnapshot(io, sessionId) {
  if (!io || !sessionId) return;
  const now = Date.now();
  const last = lastEmit.get(sessionId) || 0;
  if (now - last < EMIT_THROTTLE_MS) return;
  lastEmit.set(sessionId, now);
  try {
    const live = buildLiveSnapshot(readScreen(sessionId));
    broadcast(io, EVENTS.SCREEN, { sessionId, live });
  } catch {
    // An indicator must never take the output path down with it.
  }
}

/**
 * Read the mirror's raw tail into a compact live snapshot:
 *   { working, prompt, tool } — each null when absent.
 */
export function buildLiveSnapshot(rawBytes, profile = CLAUDE_PROFILE) {
  const screen = parseScreen(rawBytes, profile);
  const events = applyScreenStream(screen, profile);

  let working = null;
  let prompt = null;
  let tool = null;
  for (const ev of events) {
    if (ev.kind === "working") working = ev.verb;
    else if (ev.kind === "prompt" && !prompt) prompt = { question: ev.question, options: ev.options.map((o) => o.label) };
    else if (ev.kind === "tool" && ev.status !== "done" && ev.status !== "error" && !tool) tool = ev.tool;
  }
  return { working, prompt, tool };
}
