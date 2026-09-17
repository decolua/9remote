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
import { CLAUDE_SESSION_ID_RE, isClaudeInjectedTurn } from "./claudeTranscript.js";

// Overridable so a test can point at its own projects tree: the real one is the user's
// whole chat history, and a lookup scans every project directory for the id.
const projectsDir = () => process.env.NREMOTE_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");

/**
 * The session's transcript file, found by id rather than by cwd: the CLI records it
 * under the directory it was STARTED in, and the terminal may have cd'd away since.
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

const parseLines = (file) => {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
};

/** Text of a user record, whether the CLI stored it as a string or a content block. */
const userText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => b?.type === "text");
    return block?.text || "";
  }
  return "";
};

/**
 * A record the user typed: not a sub-agent's turn, not a tool result, and not one of the
 * messages the CLI writes into the transcript under the user's role (see
 * isClaudeInjectedTurn).
 *
 * This is the only filter left in 9Remote's hands, which makes it the one place the two
 * sides can disagree: the client counts turns from the end of its own log, and a turn
 * this drops but the log kept makes EVERY index after it off by one. A wrong index is no
 * longer silently destructive — the CLI answers `stale_target` — but it is still the one
 * thing here worth measuring against a real transcript.
 */
const isUserTurn = (record) =>
  record?.type === "user" && !record.isSidechain && Boolean(userText(record)) && !isClaudeInjectedTurn(record);

/**
 * The user turns a rewind can land on, oldest first.
 *
 * Only records carrying a uuid count: that uuid is what the control requests take, and
 * a tool-result record is the CLI's own bookkeeping, not a turn the user asked for.
 *
 * No files per point: what a rewind would touch is answered by the CLI itself, for the
 * turn actually picked (`rewind_files` with `dry_run`), rather than guessed here for
 * every turn up front.
 */
export function listRewindPoints(cliSessionId) {
  const file = findTranscript(cliSessionId);
  if (!file) return [];
  const points = [];
  for (const record of parseLines(file)) {
    if (!isUserTurn(record) || !record.uuid) continue;
    points.push({
      messageId: record.uuid,
      text: userText(record).slice(0, 200),
      createdAt: record.timestamp || null
    });
  }
  return points;
}
