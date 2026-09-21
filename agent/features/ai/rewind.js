// Rewind support, per engine.
//
// What each CLI can actually do was established by probing the installed binaries, not
// by reading their help text — see agent/test/spike-codexRevert.mjs for the codex
// evidence. The short version:
//
//   opencode  undo a prompt and restore the files it touched, over HTTP
//   claude    --rewind-files, plus a cut of its own transcript in place
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
  // `files: false` on the strength of a measurement, not of the docs: opencode's snapshot
  // store (~/.local/share/opencode/snapshot/<project>/<hash>) holds git dirs with ZERO
  // commits on this version, so `revert/stage` answers `{files: []}` and a commit puts
  // nothing back — see opencodeRewindE2E.test.mjs, which asserts exactly that. The
  // conversation half does work, which is what stays true here.
  opencode: { conversation: true, files: false, how: "opencode server: the conversation rolls back; this CLI keeps no file snapshot" },
  claude: { conversation: true, files: true, how: "claude --rewind-files, plus a cut of its transcript" },
  // `thread/revert` replaces the thread's own history with the prefix before a turn —
  // measured on the real server: 3 turns cut before the 2nd left 1, under the SAME thread
  // id. `fork` was the earlier reading and it is not a rewind (it mints a second
  // conversation). The file half stays false and is not a gap in this file: codex's own
  // protocol says the client is responsible for file changes, and it keeps no checkpoint.
  codex: { conversation: true, files: false, how: "codex thread/revert, conversation only" },
  antigravity: { conversation: false, files: false, how: "no app-server API for /rewind" },
  // omp's session tree branches in place (RPC `branch`); files have no snapshot.
  omp: { conversation: true, files: false, how: "omp branch + session file, conversation only" }
});

export function rewindSupport(engine) {
  return REWIND_SUPPORT[engine] || { conversation: false, files: false, how: "unsupported engine" };
}

export const canRewind = (engine) => rewindSupport(engine).conversation;

/**
 * A turn named by position, counted from the END of the thread.
 *
 * The client's own message ids are minted locally (`u-<timestamp>`), so they mean
 * nothing to a CLI. Its edit button therefore sends an offset instead: the tail is the
 * part both sides always agree on, whatever paging hid at the top of the pane.
 * Returns undefined for an offset that is not a turn — the caller refuses.
 */
export function resolveRewindTarget(points, index) {
  // Absent is not zero: `Number(null)` is 0, which would silently name the newest turn
  // for a client that sent nothing at all.
  if (index === null || index === undefined || index === "") return undefined;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= points.length) return undefined;
  return points[points.length - 1 - i].messageId;
}

export function unsupportedReason(engine) {
  return `${engine} cannot rewind a conversation: ${rewindSupport(engine).how}.`;
}
