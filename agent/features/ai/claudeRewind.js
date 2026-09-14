// Rewind for Claude Code conversations, driven from the agent host.
//
// Claude Code ships the machinery but only turns it on for the interactive TUI. Under
// the SDK entrypoint — which is how 9Remote drives the CLI — the transcript gets no
// `file-history-snapshot` and no backup, so nothing can be restored. Setting
// CLAUDE_FILE_CHECKPOINTING_ENV on the spawn (see adapters/env.js) is what enables it;
// with that env the CLI writes both, and the flag below does the file half.
//
//   --rewind-files <userMessageUuid>   restore files to their state at that message
//
// The conversation half is NOT a flag: `--resume-session-at` only truncates the context
// the CLI loads, it does not shorten the transcript, so the old turns stay on disk and
// come back. It is also what `--fork-session` had to be paired with, and that pairing
// minted a new session id — a second `.jsonl` for one conversation, which is what the
// history list showed as two chats. `cutAt` rewrites the transcript in place instead,
// keeping the session id; see its comment and agent/test/spike-rewindInPlace.mjs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBin } from "./constants.js";
import { CLAUDE_SESSION_ID_RE } from "./claudeTranscript.js";
import { getExtendedEnv } from "./adapters/env.js";

// The CLI can take a few seconds to boot before it prints its one line of output.
const REWIND_TIMEOUT_MS = 60000;

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

/** A turn the user typed — the only kind a rewind point or a cut boundary is. */
const isTurn = (line) => {
  try {
    const record = JSON.parse(line);
    return record.type === "user" && !record.isSidechain && Boolean(userText(record));
  } catch { return false; }
};

/**
 * The user turns a rewind can land on, oldest first.
 *
 * Only records carrying a uuid count: that uuid is what the CLI's two flags take, and
 * a tool-result record is the CLI's own bookkeeping, not a turn the user asked for.
 */
export function listRewindPoints(cliSessionId) {
  const file = findTranscript(cliSessionId);
  if (!file) return [];
  // Parsed once and indexed by checkpoint: resolving each point's files on its own would
  // re-read and re-parse the whole transcript per turn, which is quadratic on a long
  // conversation (a 200-turn chat parsed the file 200 times).
  const records = parseLines(file);
  const checkpoints = checkpointIndex(records);
  const points = [];
  for (const record of records) {
    if (record.type !== "user" || record.isSidechain) continue;
    if (!record.uuid) continue;
    const text = userText(record);
    if (!text) continue;
    points.push({
      messageId: record.uuid,
      text: text.slice(0, 200),
      createdAt: record.timestamp || null,
      files: backupsOf(checkpoints.get(record.uuid))
    });
  }
  return points;
}

/** Snapshots by the message id they belong to — the CLI's own key for a checkpoint. */
function checkpointIndex(records) {
  const byMessage = new Map();
  for (const record of records) {
    if (record.type !== "file-history-snapshot" || !record.messageId) continue;
    const tracked = record.snapshot?.trackedFileBackups;
    if (tracked && Object.keys(tracked).length > 0) byMessage.set(record.messageId, tracked);
  }
  return byMessage;
}

// A tracked entry names a backup file, not a path on disk — resolve it for display.
const backupsOf = (tracked) => Object.values(tracked || {}).map((e) => e?.backupFileName).filter(Boolean);

/**
 * Files a rewind to `messageId` would put back.
 *
 * Read from a session whose transcript has them populated. The catch: the ORIGINAL
 * session's snapshots carry an empty `trackedFileBackups` even when the CLI wrote
 * backups to disk — only a session that was loaded and re-saved (a fork) gets the
 * mapping filled in. So this is exact for a forked session and empty for an untouched
 * one; callers must not read an empty list as "no files will change" (see previewRewind).
 */
function filesAt(file, messageId) {
  return backupsOf(checkpointIndex(parseLines(file)).get(messageId));
}

/** Run the CLI once with extra args and return everything it printed. */
function runClaude(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin(), args, {
      cwd: cwd || process.cwd(),
      env: getExtendedEnv({ hostSessionId: "" })
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: "The CLI did not answer in time." }); }, REWIND_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().slice(0, 400) || `claude exited ${code}` });
      resolve({ ok: true, stdout: out.trim() });
    });
  });
}

/**
 * Put the files back the way they were at `messageId`.
 *
 * `--rewind-files` prints what it did and rewinds nothing else, so this is safe to run
 * on its own — the conversation is untouched.
 */
export async function rewindFiles(sessionId, messageId, cwd) {
  if (!sessionId || !messageId) return { ok: false, error: "Missing session or message id." };
  return await runClaude(["-p", "--resume", sessionId, "--rewind-files", messageId], cwd);
}

/**
 * Cut the conversation at a turn, in place, under the SAME session id.
 *
 * Not a fork. Claude Code's own `/rewind` moves the leaf inside one transcript file
 * (anthropics/claude-code#55347), and the CLI accepts a transcript truncated by hand:
 * measured against 2.1.270 — resume loads the shortened thread, keeps the id, appends
 * to the same file afterwards (see agent/test/spike-rewindInPlace.mjs).
 *
 * The fork this replaces was the bug, not just a way of doing it: `--fork-session` mints
 * a new session id, so a rewind left a SECOND `.jsonl` in the project directory, and the
 * history list enumerates that directory — one rewind, two conversations on screen.
 *
 * The cost is real and the UI says so: the turns after the cut are gone from this
 * conversation. A branch that survives alongside the original cannot exist without a
 * second file, which is the thing being fixed.
 *
 * `keepThroughUuid` is `undefined` for "no rewind target in this conversation" (refuse),
 * `null` for "keep nothing" (the target is the first turn).
 */
export function cutAt(sessionId, keepThroughUuid) {
  if (keepThroughUuid === undefined) return { ok: false, error: "No rewind target in this conversation." };
  const file = findTranscript(sessionId);
  if (!file) return { ok: false, error: "This conversation's transcript is not on disk." };
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { ok: false, error: "Could not read this conversation." }; }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (keepThroughUuid === null) {
    // Nothing survives but the header: a zero-byte transcript makes the CLI report
    // "No conversation found" and the session becomes unusable (verified), so the
    // file keeps its own records and a summary that says what happened.
    const kept = [
      ...conversationHeader(lines, lines.length),
      JSON.stringify({ type: "summary", summary: "Rewound to the start of this conversation", sessionId })
    ];
    return writeTranscript(file, kept);
  }
  const cut = lines.findIndex((line) => {
    try { return JSON.parse(line).uuid === keepThroughUuid; } catch { return false; }
  });
  if (cut === -1) return { ok: false, error: "That turn is no longer in this conversation." };
  // The kept turn's own answer comes AFTER its uuid, so the cut lands on the next turn
  // the user typed — otherwise the reply to the turn that was kept is discarded and the
  // pane shows a prompt with nothing under it (the rewind target is the turn BEFORE the
  // one being rewound). Everything from there on goes, including any branch off it.
  const next = lines.findIndex((line, i) => i > cut && isTurn(line));
  return writeTranscript(file, next === -1 ? lines : lines.slice(0, next));
}

/** Atomic: a crash mid-write must not leave a half transcript behind. */
function writeTranscript(file, kept) {
  const tmp = `${file}.rewind`;
  try {
    fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: "Could not write this conversation." };
  }
  return { ok: true };
}

/**
 * The session's non-conversation records — the `mode`/`permission-mode` pair at the top
 * of every transcript and anything else that is not a turn. They carry no history, so
 * keeping them cannot undo a rewind, and without them the file names no session.
 */
function conversationHeader(lines, upTo) {
  return lines.slice(0, upTo).filter((line) => {
    try {
      const record = JSON.parse(line);
      return record.type !== "user" && record.type !== "assistant" && record.type !== "attachment";
    } catch { return false; }
  });
}

/**
 * The turn a rewind to `messageId` must keep: the one immediately before it.
 *
 * Two outcomes, and the caller must not conflate them:
 *   - a uuid  → the cut keeps everything through there
 *   - null    → the target is the FIRST turn, so nothing is kept
 */
export function rewindTarget(sessionId, messageId) {
  const points = listRewindPoints(sessionId);
  const idx = points.findIndex((p) => p.messageId === messageId);
  if (idx === -1) return undefined;   // unknown target — caller should refuse
  if (idx === 0) return null;         // keep nothing
  return points[idx - 1].messageId;
}

/** Stage without applying: what a rewind to this turn would change. */
export async function previewRewind(sessionId, messageId, { files = true } = {}) {
  const known = files ? filesForCheckpoint(sessionId, messageId) : [];
  return {
    ok: true,
    messageId,
    files: known,
    snapshot: null,
    // An empty list is NOT "nothing will change": the CLI fills the file mapping only
    // once a session has been loaded and re-saved, so an untouched session reports
    // nothing while its backups sit on disk. Say so instead of implying safety.
    filesUnknown: files && known.length === 0,
    note: known.length > 0
      ? "These files will be restored. Files changed by a shell command are not tracked and stay as they are."
      : "Claude Code does not report which files a rewind will restore for this session. Files it wrote with Edit/Write are restored; files changed by a shell command are not."
  };
}

/**
 * Backups a rewind to `messageId` would restore, looked up by the checkpoint's own id.
 *
 * Snapshot records keep the ORIGINAL message id even in a forked session, while its user
 * turns get new uuids — so this reads the snapshots directly rather than going through
 * `listRewindPoints`. Empty is "the CLI did not report it", not "nothing changes".
 */
export function filesForCheckpoint(sessionId, messageId) {
  const file = findTranscript(sessionId);
  return file ? filesAt(file, messageId) : [];
}

export async function applyRewind(sessionId, messageId, { files = true, cwd = null } = {}) {
  const before = filesForCheckpoint(sessionId, messageId);
  // The file half runs first, while the transcript still names this turn's checkpoint —
  // the cut below removes it. It is a one-shot CLI run against the ORIGINAL id, which
  // the conversation keeps.
  if (files) {
    const res = await rewindFiles(sessionId, messageId, cwd);
    if (!res.ok) return { ok: false, error: res.error, messageId };
  }
  // The conversation half is a cut in place: the turns after the one BEFORE `messageId`
  // go, and the session keeps its id — so no second transcript, no second history row.
  const cut = cutAt(sessionId, rewindTarget(sessionId, messageId));
  if (!cut.ok) return { ok: false, error: cut.error, messageId, filesRewound: files };
  return {
    ok: true,
    messageId,
    files: before,
    // An empty list is "the CLI did not report it", not "nothing changes" — say so.
    filesUnknown: files && before.length === 0,
    conversation: true
  };
}
