// Rewind for Claude Code conversations, driven from the agent host.
//
// Claude Code ships the machinery but only turns it on for the interactive TUI. Under
// the SDK entrypoint — which is how 9Remote drives the CLI — the transcript gets no
// `file-history-snapshot` and no backup, so nothing can be restored. Setting
// CLAUDE_FILE_CHECKPOINTING_ENV on the spawn (see adapters/env.js) is what enables it;
// with that env the CLI writes both, and the two flags below do the rewind.
//
//   --rewind-files <userMessageUuid>   restore files to their state at that message
//   --resume-session-at <uuid>         resume with the conversation cut at that message
//
// Both are real flags the CLI parses; neither appears in `--help`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
 * Cut the conversation at a turn and continue under a NEW session id.
 *
 * Three things here are semantics, not plumbing:
 *
 * `--resume-session-at <uuid>` KEEPS the turn whose uuid is given and drops everything
 * after it. "Rewind to prompt X" means dropping X as well, so the caller passes the uuid
 * of the turn BEFORE X — see `rewindTarget`.
 *
 * `--fork-session` is what makes the cut real. Without it the CLI answers from the full
 * context and APPENDS to the same transcript, so nothing is discarded (verified: the
 * model still recalled a turn that had supposedly been rewound). With it the CLI
 * requires `--session-id`, so passing one keeps a predictable id instead of an unknown
 * fork.
 *
 * The CLI cannot fork without a prompt, and the prompt becomes a real user turn in the
 * new transcript. `stripForkPrompt` removes that turn afterwards, so the forked
 * conversation is exactly the history that was kept.
 */
export async function forkAt(sessionId, keepThroughUuid, { cwd = null, newSessionId = null } = {}) {
  // `undefined` means "no cut asked for"; `null` means "keep nothing". Both omit the
  // flag, but only the second is a rewind, so the caller resolves that beforehand.
  if (keepThroughUuid === undefined) return { ok: false, error: "No rewind target in this conversation." };
  const target = newSessionId || crypto.randomUUID();
  const marker = `${FORK_MARKER}${crypto.randomUUID()}`;
  const args = ["-p", marker, "--resume", sessionId, "--fork-session", "--session-id", target];
  // A null target keeps nothing, and the flag cannot express that: omitting it keeps
  // everything. The conversation is made empty by cutting at its own first turn.
  if (keepThroughUuid) args.push("--resume-session-at", keepThroughUuid);
  const res = await runClaude(args, cwd);
  if (!res.ok) return { ok: false, error: res.error };
  // The marker turn is the CLI's price for forking; leaving it in would show up as a
  // user message the person never sent, and the model would read it as one.
  const stripped = stripForkPrompt(target, marker, { dropAll: !keepThroughUuid });
  if (!stripped) return { ok: false, error: "Could not clean the forked conversation." };
  return { ok: true, sessionId: target };
}

// Marks the throwaway prompt a fork needs. Kept odd enough that a real prompt never
// matches it, and removed before the session is ever read back.
const FORK_MARKER = "9remote-rewind-marker-";

/**
 * Drop the marker turn (and the reply it drew) from a freshly forked transcript.
 *
 * Everything before the marker is the history the fork kept, so the cut is made at the
 * marker's own line — the records after it are the throwaway turn's.
 *
 * `dropAll` is the rewind-to-the-first-turn case: the CLI is given no cut point, so it
 * forked the WHOLE conversation and the caller wanted none of it. Even then the file
 * cannot be emptied — a zero-byte transcript makes the CLI report "No conversation
 * found" and the session becomes unusable (verified). The session's own header records
 * are kept so the file still names a conversation, and a small `summary` marks it as
 * rewound rather than blank.
 *
 * Written through a temp file so a crash mid-write cannot leave a half transcript.
 */
function stripForkPrompt(cliSessionId, marker, { dropAll = false } = {}) {
  const file = findTranscript(cliSessionId);
  if (!file) return false;
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return false; }
  const lines = raw.split("\n").filter((l) => l.trim());
  const cut = lines.findIndex((line) => {
    if (!line.includes(marker)) return false;
    try { return userText(JSON.parse(line)).includes(marker); } catch { return false; }
  });
  if (cut === -1) return false;
  const kept = dropAll
    ? [...conversationHeader(lines, cut), JSON.stringify({ type: "summary", summary: "Rewound to the start of this conversation", sessionId: cliSessionId })]
    : lines.slice(0, cut);
  const tmp = `${file}.rewind`;
  try {
    fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
  return true;
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
 *   - a uuid  → pass it as `--resume-session-at`; the cut keeps everything through there
 *   - null    → the target is the FIRST turn, so nothing should be kept. `forkAt` must
 *               then omit the flag entirely: omitting it keeps the WHOLE conversation,
 *               which is the opposite of what this rewind asked for.
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
  if (files) {
    const res = await rewindFiles(sessionId, messageId, cwd);
    if (!res.ok) return { ok: false, error: res.error, messageId };
  }
  // The conversation half forks: the CLI cuts the thread at the turn BEFORE this one
  // and continues under an id we choose, which the caller hands to setOptions({resume}).
  const fork = await forkAt(sessionId, rewindTarget(sessionId, messageId), { cwd });
  if (!fork.ok) return { ok: false, error: fork.error, messageId, filesRewound: files };
  // The fork's transcript carries the file mapping the source session leaves blank.
  const after = filesForCheckpoint(fork.sessionId, messageId);
  return {
    ok: true,
    messageId,
    files: after.length > 0 ? after : before,
    filesUnknown: files && after.length === 0 && before.length === 0,
    conversation: true,
    // The session id the caller must resume — the CLI cut the thread and continues here.
    newSessionId: fork.sessionId
  };
}
