// The rewind POINTS of a Claude Code conversation, read from its transcript.
//
// Only the reading lives here. The rewind itself is a control request to the CLI that
// already owns the conversation (see claudeAdapter.rewindConversation / rewindFiles),
// which is why there is no cut, no write and no respawn in this file any more.
//
// What used to be here: `--rewind-files` spawned as a one-shot CLI for the file half, and
// a hand-rolled slice of the `.jsonl` for the conversation half. The slice existed because
// `--resume-session-at` only truncates the context the CLI LOADS, not the transcript, and
// `--fork-session` minted a second session id — so the file itself was rewritten in place,
// underneath a running process that held the discarded turns in memory. Keeping that
// process from flushing them back over the cut is what agent/test/spike-rewindRace.mjs was
// written to measure, and what the stop→cut→start dance in aiSocket worked around.
//
// The CLI implements `rewind_conversation` and `rewind_files` as control requests over the
// stream-json pipe the adapter already holds open. It cuts its own conversation in its own
// memory, under the same session id, and checkpoints the files itself. Measured end to end
// in agent/test/spike-controlRewind.mjs: the cut takes, the id survives, the transcript
// stays ONE file, and it works from a process started with `--resume`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_SESSION_ID_RE, isTypedTurn, textOf, liveTranscript } from "./claudeTranscript.js";

// Overridable so a test can point at its own projects tree: the real one is the user's
// whole chat history, and a lookup scans every project directory for the id.
const projectsDir = () => process.env.NREMOTE_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");

/**
 * The session's transcript file, found by id rather than by cwd: the CLI records it
 * under the directory it was STARTED in, and the terminal may have cd'd away since.
 *
 * `projectsDir()` is overridable (see above) so a test can point at its own tree; the
 * path confinement the other reader does is not repeated here because this one is only
 * ever handed a uuid already validated by CLAUDE_SESSION_ID_RE, and it never joins a
 * caller-supplied directory into the path.
 */
export function findTranscript(cliSessionId) {
  if (!cliSessionId || !CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const root = projectsDir();
  let entries;
  try { entries = fs.readdirSync(root); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(root, entry, `${cliSessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The user turns a rewind can land on, oldest first.
 *
 * Reads the transcript through `liveTranscript`, so the list holds exactly the turns the
 * pane draws: a turn a rewind already dropped is still in the file, and offering it here
 * named a turn by a position the pane does not have — every index below it landed one turn
 * too far down, which showed up as "only the newest message can be rewound". It also sent
 * the CLI a turn it no longer holds, which answers `target_not_found` and looks, from the
 * pane, like nothing happened at all.
 *
 * "A turn" is `isTypedTurn`, the reader's own test, for the same reason: a tool result is
 * stored as a `user` record too, and counting one shifts every index under it.
 *
 * No files per point: what a rewind would touch is answered by the CLI itself, for the
 * turn actually picked (`rewind_files` with `dry_run`), rather than guessed here for
 * every turn up front.
 */
export function listRewindPoints(cliSessionId) {
  const file = findTranscript(cliSessionId);
  if (!file) return [];
  const { lines, live } = liveTranscript(file);
  const points = [];
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record.uuid || !isTypedTurn(record)) continue;
    if (live && !live.has(record.uuid)) continue;
    points.push({
      messageId: record.uuid,
      text: textOf(record).slice(0, 200),
      createdAt: record.timestamp || null
    });
  }
  return points;
}
