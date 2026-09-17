// Rewind for codex conversations, asked of the app-server that owns the thread.
//
// Two doors were measured against the real server before this file existed (see
// spike-codexRevert.mjs, and the probe that produced the numbers below):
//
//   thread/fork    a NEW thread id — a rewind that way shows up as a second conversation,
//                  which is the bug Clave's transcript cut was written to avoid.
//   thread/revert  the SAME thread, history replaced by the prefix before one turn.
//                  Measured: 3 turns, `beforeTurnId` = the 2nd → 1 turn left, same id.
//
// So the conversation half is a rewind. The FILE half is not: the server's own note says
// so ("does not revert local file changes ... clients are responsible"), and this engine
// has no checkpoint to restore from. `files: false` in the support table is that fact, and
// the preview says it in words rather than leaving the dialog to imply otherwise.
//
// The turn ids come from the server, not from the transcript: `thread/turns/list` is the
// same store `thread/revert` cuts, so a target resolved from it is one it will accept.
import { createLogger } from "../../lib/logger.js";

const log = createLogger("codexRewind");

const TURNS_TIMEOUT_MS = 15000;

/**
 * A thread's turns, oldest first, in the shape the rewind dialog reads.
 *
 * `itemsView: "summary"` is deliberate: the dialog needs each turn's id and the prompt a
 * person typed to name it, and `full` walks every item of every turn in the thread.
 */
export async function listRewindPoints(session, { turns = 50 } = {}) {
  const rpc = session?.adapter?.appServer?.rpc;
  const threadId = session?.adapter?.activeThreadId;
  if (!rpc || !threadId) return [];
  const res = await rpc.request("thread/turns/list", {
    threadId, limit: turns, sortDirection: "asc", itemsView: "summary"
  }, { timeoutMs: TURNS_TIMEOUT_MS });
  const list = res?.data || [];
  return list.map((turn) => ({
    messageId: turn.id,
    text: turnText(turn).slice(0, 200),
    createdAt: turn.startedAt ? turn.startedAt * 1000 : null
  }));
}

/** The prompt a person typed, out of a turn's own items. */
function turnText(turn = {}) {
  for (const item of turn.items || []) {
    if (item.type !== "userMessage") continue;
    const parts = item.content || [];
    for (const c of parts) {
      if (typeof c === "string") return c;
      if (c?.text) return c.text;
    }
  }
  return "";
}

/**
 * Replace this thread's history with everything before `beforeTurnId`.
 *
 * The same thread is kept — no fork, no second conversation — and the caller reloads the
 * log from the transcript afterwards, exactly as the other engines' rewinds do.
 */
export async function applyRewind(session, beforeTurnId) {
  const rpc = session?.adapter?.appServer?.rpc;
  const threadId = session?.adapter?.activeThreadId;
  if (!rpc || !threadId) return { ok: false, error: "This chat has no codex thread to rewind." };
  try {
    await rpc.request("thread/revert", { threadId, beforeTurnId }, { timeoutMs: TURNS_TIMEOUT_MS });
    return { ok: true, messageId: beforeTurnId, files: [], filesUnknown: false, note: FILES_NOTE };
  } catch (err) {
    log.warn(`revert failed: ${err.message}`);
    return { ok: false, error: `codex refused the rewind: ${err.message}` };
  }
}

/**
 * What this rewind WOULD change. There is no file half to ask about, so the answer is the
 * absence of one — stated, not omitted: a dialog that showed nothing would read as
 * "nothing changes", which is a different claim.
 */
export async function previewRewind(session, beforeTurnId) {
  const rpc = session?.adapter?.appServer?.rpc;
  const threadId = session?.adapter?.activeThreadId;
  if (!rpc || !threadId) return { ok: false, error: "This chat has no codex thread to rewind." };
  // The turn must still be one the server knows, or the cut would be accepted and land
  // somewhere else. Checked by asking for the same list `thread/revert` cuts.
  const points = await listRewindPoints(session).catch(() => []);
  if (!points.some((p) => p.messageId === beforeTurnId)) {
    return { ok: false, error: "That turn is no longer in this conversation. Reload the chat and try again." };
  }
  return { ok: true, messageId: beforeTurnId, files: [], filesUnknown: false, note: FILES_NOTE };
}

const FILES_NOTE = "Codex rewinds the conversation only — its server does not restore file changes.";
