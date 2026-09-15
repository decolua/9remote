// Constants for AI Features in 9remote

export const AI_ENGINES = {
  CLAUDE: "claude",
  CODEX: "codex",
  OPENCODE: "opencode",
  ANTIGRAVITY: "antigravity"
};

// The chat engine binary. Overridable so a test can point at a stand-in: the agent
// spawns with its own PATH prepended (adapters/env.js), so a fake placed earlier on the
// caller's PATH loses to a real install and the test silently drives the real CLI.
export function claudeBin() {
  return process.env.NREMOTE_CLAUDE_BIN || "claude";
}

export const AI_SOCKET_EVENTS = {
  CREATE: "ai:create",
  PROMPT: "ai:prompt",
  PERMISSION: "ai:permission",
  QUESTION: "ai:question",
  STOP: "ai:stop",
  RESET: "ai:reset",
  OPTIONS: "ai:options",
  DESTROY: "ai:destroy",
  LIST: "ai:list",
  REWIND: "ai:rewind",
  EVENT: "ai:event"
};

// How long a codex/opencode turn may go silent before it is treated as hung. Both CLIs
// occasionally stall on startup (provider hiccup, prompt cache miss) and then never
// emit anything — without this the turn stays "running" forever and the chat shows no
// reply and no error. Claude is excluded: its PTY daemon owns that lifecycle instead.
export const AI_TURN_IDLE_TIMEOUT_MS = 120000;

// How long a sub-agent or background shell may go without a sign of life before its row
// is settled. Same window as a turn, deliberately: the two are the same question — "is
// this still going" — asked one level down.
//
// Neither has an end signal to listen for. A background shell's `tool_result` is the
// CLI's launch ack, and a sub-agent has no handle at all (it is a thread inside the CLI
// process, verified: no child process appears while one runs). So both rows stay live on
// this window, and a later tool call naming the same id ends them early.
export const AI_ASYNC_IDLE_TIMEOUT_MS = AI_TURN_IDLE_TIMEOUT_MS;

// Chat snapshots are written on a debounce while a turn streams, not only when it
// ends. A turn that is killed mid-flight (SIGKILL, power loss) otherwise leaves
// nothing on disk at all — the pane comes back empty after a restart, which is
// exactly what "the chat survives a restart" must not mean.
export const AI_PERSIST_DEBOUNCE_MS = 150;

// While a turn is streaming, most events are delta slices of one growing message: at
// the idle cadence a long chat re-serializes megabytes many times a second. A turn
// boundary flushes synchronously regardless, so this window only bounds what an
// unclean kill can cost — a fraction of the current turn, never the conversation.
export const AI_PERSIST_STREAM_MS = 1000;

// Tail replayed on connect, and the size of each scroll-up fetch. Measured on a real
// conversation: 6.9 MB of events for one long chat, enough to stall a phone on F5.
//
// A budget of serialized event bytes, and it must leave room for the envelope around
// them (session metadata, skills) under CONTROL_RTC_MAX_BYTES: the reply rides the RTC
// control channel in one SCTP message, and one byte over is thrown away — a chat that
// then sits on "Syncing…" forever, since every re-ask rebuilds the same oversize frame.
// The oldest turns stay reachable through the scroll-up fetch.
export const AI_REPLAY_BYTES = 32 * 1024;

// How far past the replay budget a window may stretch to carry a tool call its own
// results need. The packing budget leaves ~32KB unused under the 64KB SCTP cap, and a
// tool_start sitting just above a window's start costs a few hundred bytes to include —
// but without it the client drops the matching tool_result whole, card and output both
// (measured: 90 results across 33 of 39 real chats). Only a window that fits within this
// ceiling is widened; the packing budget itself is untouched, so a window is never less
// than it was before.
export const AI_REPLAY_WIDEN_BYTES = 48 * 1024;

// The chat log is the agent's own store now. Same ceilings the daemon used: bound the
// in-memory log, and cap what one tool result contributes to it.
export const AI_MAX_EVENTS = 5000;
// A cap on one event, so no single tool result can fill a replay window on its own —
// at 64KB one `cat` of a big file was larger than the whole tail budget, and every
// window holding it went over the wire limit with it.
export const AI_MAX_TOOL_OUTPUT = 16 * 1024;

// How long a `/doctor` health check may run before it is killed.
export const AI_DOCTOR_TIMEOUT_MS = 30000;

// How long an engine's model catalog is reused. Each create re-reads it (a connecting
// client must see the host's current list), and codex/opencode answer by spawning a
// CLI — 0.2s and 1.3s measured — which would otherwise be paid on every F5.
export const AI_MODEL_CACHE_TTL_MS = 30000;
