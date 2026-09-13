// Rewind for opencode conversations, driven from the agent host.
//
// The conversation is read from opencode's own SQLite rather than its server: the
// server's v2 store cannot see sessions that `opencode run` created (verified — the
// session resolves by id, its messages come back empty), and those are exactly the
// sessions 9Remote runs.
//
// The file half goes through the server, because the snapshot/restore machinery lives
// there. Staging is reversible, so it is also how the confirm dialog learns which files
// would be overwritten.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageRevert, clearRevert, commitRevert, isV2Session } from "./opencodeServer.js";
import { rewindSupport } from "./rewind.js";

const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

// node:sqlite ships with Node 22.5+; an older runtime simply cannot rewind opencode.
function openDb() {
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * User turns of one conversation, oldest first, with the files each one's agent work
 * touched. Message ids come from opencode's own rows, so they are what its server
 * expects back — nothing here mints an id.
 */
export function listRewindPoints(sessionId) {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare("select id, data from message where session_id = ? order by time_created asc")
      .all(sessionId);
    const points = [];
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      if (data?.role !== "user") continue;
      points.push({
        messageId: row.id,
        text: String(data.summary?.title || data.summary?.body || "").slice(0, 200),
        createdAt: data.time?.created || null,
        files: filesAfter(db, sessionId, row.id)
      });
    }
    return points;
  } finally {
    db.close();
  }
}

/**
 * Files the agent changed in the turn that started at `messageId`.
 *
 * opencode records a `patch` part carrying the paths for each step, so this is read
 * from the conversation rather than guessed from the working tree — an unrelated edit
 * the user made by hand must never appear here.
 */
function filesAfter(db, sessionId, messageId) {
  try {
    const rows = db
      .prepare(
        `select p.data from part p
           join message m on m.id = p.message_id
          where p.session_id = ? and m.time_created >= (select time_created from message where id = ?)
            and p.data like '%"type":"patch"%'`
      )
      .all(sessionId, messageId);
    const files = new Set();
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      for (const f of data.files || []) files.add(f);
    }
    return [...files];
  } catch {
    return [];
  }
}

/** The conversation a 9Remote session is running, if opencode knows about it. */
export function rewindable(engine, cliSessionId) {
  if (!rewindSupport(engine).conversation || !cliSessionId) return null;
  if (isV2Session(cliSessionId)) return cliSessionId;
  const db = openDb();
  if (!db) return null;
  try {
    const row = db.prepare("select id from session where id = ?").get(cliSessionId);
    return row ? cliSessionId : null;
  } finally {
    db.close();
  }
}

/**
 * Stage a rewind to a user turn, then apply it.
 *
 * Returns what was restored, plus the paths the engine could not vouch for (it reports
 * those itself and leaves them as they are — a partial restore that claims success is
 * the worst outcome, so the caller is told).
 */
export async function applyRewind(sessionId, messageId, { files = true } = {}) {
  const staged = await stageRevert(sessionId, messageId, { files });
  const changed = (staged?.files || []).map((f) => f.file);
  await commitRevert(sessionId);
  return {
    ok: true,
    messageId,
    files: changed,
    snapshot: staged?.snapshot || null
  };
}

/** Stage without applying, so the confirm dialog can name the files first. */
export async function previewRewind(sessionId, messageId, { files = true } = {}) {
  const staged = await stageRevert(sessionId, messageId, { files });
  // Leave nothing staged behind — a staged revert that is never committed keeps the
  // session in a half-reverted state the next prompt would commit by accident.
  await clearRevert(sessionId).catch(() => {});
  return {
    ok: true,
    messageId,
    files: (staged?.files || []).map(({ file, status, additions, deletions }) => ({ file, status, additions, deletions })),
    snapshot: staged?.snapshot || null
  };
}
