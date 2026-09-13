// Rewind support, per engine.
//
// What each CLI can actually do was established by probing the installed binaries, not
// by reading their help text — see agent/test/spike-codexRevert.mjs for the codex
// evidence. The short version:
//
//   opencode  undo a prompt and restore the files it touched, over HTTP
//   claude    --rewind-files + --resume-session-at, once SDK checkpointing is enabled
//   codex     forks a conversation; it cannot rewind one, and never restores files
//   antigravity  /rewind rolls the conversation back, files are undocumented
//
// Claude's `files: true` is conditional in a way the table cannot express: the CLI only
// checkpoints a session that was SPAWNED with CLAUDE_FILE_CHECKPOINTING_ENV (see
// adapters/env.js). A session opened before that env was set has no backup to restore
// and its rewind reports the failure rather than silently doing nothing.
//
// An engine missing from this table gets no rewind control in the UI at all — better a
// button that is not there than one that silently rewinds nothing.

/** Per-engine rewind support. `files` means the engine can restore what the agent wrote. */
export const REWIND_SUPPORT = Object.freeze({
  opencode: { conversation: true, files: true, how: "opencode server: stage, then commit" },
  claude: { conversation: true, files: true, how: "claude --rewind-files / --resume-session-at" },
  codex: { conversation: false, files: false, how: "codex forks; it has no rewind" },
  antigravity: { conversation: false, files: false, how: "no app-server API for /rewind" }
});

export function rewindSupport(engine) {
  return REWIND_SUPPORT[engine] || { conversation: false, files: false, how: "unsupported engine" };
}

export const canRewind = (engine) => rewindSupport(engine).conversation;

export function unsupportedReason(engine) {
  return `${engine} cannot rewind a conversation: ${rewindSupport(engine).how}.`;
}
