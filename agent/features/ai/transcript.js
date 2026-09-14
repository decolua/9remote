// Rebuild a recent slice of a past codex/opencode conversation from the CLI's own
// store, so resuming one shows its history instead of an empty pane.
//
// Claude's reader lives in ptyDaemon's own module (claudeTranscript.js) — it reads
// `~/.claude/projects/<cwd>/<id>.jsonl`, and is imported rather than duplicated so
// the in-agent path honours a resume exactly like the daemon does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { stripHarnessWrapping } from "../terminal/agentHistory.js";
import { recoverFromClaudeTranscript, CLAUDE_SESSION_ID_RE } from "./claudeTranscript.js";

const require = createRequire(import.meta.url);

// Only the tail is replayed: a resumed chat needs enough context to read, not the
// whole transcript (which can run to thousands of events).
const MAX_EVENTS = 200;

// node:sqlite ships with Node 22.5+; an older runtime simply yields nothing.
let sqliteModule;
function loadSqlite() {
  if (sqliteModule === undefined) {
    try { sqliteModule = require("node:sqlite"); } catch { sqliteModule = null; }
  }
  return sqliteModule;
}

// Turns the harness writes into the transcript as if the user had typed them: the
// environment block, and an aborted turn's note. Replaying one as a real prompt would
// open a bubble that never gets closed, leaving a spinner stuck on the pane.
const HARNESS_TURN_RE = /^\s*<(environment_context|turn_aborted)>/;
const isHarnessTurn = (text) => HARNESS_TURN_RE.test(text);

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ──

// A thread id names exactly one rollout, forever, and a live turn asks for it once per
// file it changes — so the directory scan is memoized rather than repeated (and the
// rollout path is stable once the CLI has created it).
const rolloutPathCache = new Map();

function findCodexRollout(sessionId, cwd) {
  const key = `${cwd}\n${sessionId}`;
  if (rolloutPathCache.has(key)) return rolloutPathCache.get(key);

  const root = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(root, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  // The id is the filename's tail: rollout-<timestamp>-<id>.jsonl. Match the exact
  // tail rather than a substring, or a short id would resolve to another session.
  const suffix = `-${sessionId}.jsonl`;
  const years = fs.readdirSync(sessionsDir).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
  for (const year of years) {
    const months = safeReadDir(path.join(sessionsDir, year)).sort().reverse();
    for (const month of months) {
      const days = safeReadDir(path.join(sessionsDir, year, month)).sort().reverse();
      for (const day of days) {
        const dir = path.join(sessionsDir, year, month, day);
        for (const name of safeReadDir(dir)) {
          if (!name.endsWith(suffix)) continue;
          const file = path.join(dir, name);
          if (cwd && !rolloutMatchesCwd(file, cwd)) continue;
          rolloutPathCache.set(key, file);
          return file;
        }
      }
    }
  }
  return null;
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// session_meta carries the cwd the conversation ran in; a same-named id from
// another project must not be resumed into this one.
function rolloutMatchesCwd(file, cwd) {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
    const rec = JSON.parse(first);
    return !rec?.payload?.cwd || sameDir(rec.payload.cwd, cwd);
  } catch {
    return true;
  }
}

// Codex records the cwd it was handed, canonicalised — on macOS `/tmp/x` comes back as
// `/private/tmp/x`. Comparing them raw missed every rollout under a symlinked path, which
// showed up as a resumed chat with no diff cards rather than as an obvious failure.
function sameDir(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// The exec stream (`--json`) names a changed file but carries no patch — the patch is
// written into the rollout instead, and it is on disk before the CLI prints the matching
// item. Keyed by path: the rollout stores `changes` as an object, not a list.
export function readCodexFileChanges(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = findCodexRollout(sessionId, cwd);
  if (!file) return null;

  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return null;
  }

  const out = {};
  for (const line of lines) {
    // Skip before parsing: a thread's rollout runs to thousands of records and only a
    // handful of them are file changes.
    if (!line.includes('"FileChange"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const item = rec.payload?.item;
    if (item?.type !== "FileChange") continue;
    for (const [p, change] of Object.entries(item.changes || {})) {
      out[p] = { patch: change.unified_diff || "", content: change.content || "" };
    }
  }
  return out;
}

export function recoverFromCodexTranscript(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = findCodexRollout(sessionId, cwd);
  if (!file) return null;

  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return null;
  }

  const events = [];
  let seq = 1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== "response_item") continue;

    const p = rec.payload || {};
    if (p.type === "message") {
      const text = (p.content || [])
        .map((c) => c?.text || (typeof c === "string" ? c : ""))
        .join("");
      if (!text.trim()) continue;
      if (p.role === "user") {
        if (isHarnessTurn(text)) continue;
        const clean = stripHarnessWrapping(text);
        if (!clean) continue;
        events.push({ seq: seq++, event: "user_message", data: { text: clean } });
      } else if (p.role === "assistant") {
        // The body is not a title: unwrap it, but never collapse or truncate it.
        const clean = stripHarnessWrapping(text);
        if (!clean) continue;
        events.push({ seq: seq++, event: "delta", data: { text: clean } });
        events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
      }
    } else if (p.type === "reasoning" && p.summary) {
      const text = p.summary.map((s) => s?.text || "").join("");
      if (text.trim()) events.push({ seq: seq++, event: "thinking", data: { text } });
    }
  }

  if (events.length === 0) return null;
  return tailFromLastUser(events);
}

// Antigravity's live stream names each tool's parameters PascalCase (CommandLine for
// run_command, AbsolutePath for view_file…). The transcript keeps that spelling, while
// the chat cards read one lowercase shape — the same mapping its adapter applies live.
const ANTIGRAVITY_PARAM_ALIASES = {
  CommandLine: "command",
  AbsolutePath: "file_path",
  TargetFile: "file_path",
  DirectoryPath: "path",
  SearchDirectory: "path",
  SearchPath: "path",
  Query: "query"
};

function normalizeAntigravityArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    // The compact transcript JSON-quotes every value, so a path arrives as `"/tmp/x"`.
    const clean = typeof value === "string" && value.startsWith('"')
      ? value.replace(/^"|"$/g, "")
      : value;
    out[ANTIGRAVITY_PARAM_ALIASES[key] || key] = clean;
  }
  return out;
}

// ── Antigravity: ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl ──
//
// The CLI's own compact transcript of one conversation. Its per-conversation SQLite
// file holds the same turns, but as an undocumented binary encoding of the internal
// wire format — this JSONL is the readable one, and the CLI points its own agent at it.
export function recoverFromAntigravityTranscript(cwd, sessionId) {
  // The conversation id reaches the filesystem as a path segment (a resume choice comes
  // from a client), so it is validated like every other one. `cwd` is deliberately
  // ignored: the store is keyed by conversation id alone, and the only cwd it records
  // lives inside the harness's own prose preamble — a gate that could only ever refuse
  // a conversation the user just picked off the history list for this directory.
  if (!sessionId || !CLAUDE_SESSION_ID_RE.test(sessionId)) return null;
  const root = process.env.ANTIGRAVITY_HOME?.trim() || path.join(os.homedir(), ".gemini", "antigravity-cli");
  const logsDir = path.join(root, "brain", sessionId, ".system_generated", "logs");
  // The compact file quotes every argument value; the full one does not, and it exists
  // beside it for every conversation. Prefer the clean copy, fall back to the compact.
  const file = ["transcript_full.jsonl", "transcript.jsonl"]
    .map((name) => path.join(logsDir, name))
    .find((p) => fs.existsSync(p));
  if (!file) return null;

  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return null;
  }

  const events = [];
  const pending = []; // tool calls announced, waiting for the step that carries their result
  let seq = 1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === "USER_INPUT") {
      // The prompt is wrapped with the harness's own context blocks; only the request
      // inside <USER_REQUEST> is the user's own words.
      const text = stripHarnessWrapping(rec.content || "");
      if (text) events.push({ seq: seq++, event: "user_message", data: { text } });
      continue;
    }
    if (rec.type !== "PLANNER_RESPONSE" && rec.type !== "GENERIC") continue;

    if (rec.thinking?.trim()) events.push({ seq: seq++, event: "thinking", data: { text: rec.thinking } });

    const calls = rec.tool_calls || [];
    for (const call of calls) {
      const id = `${call.name}-${rec.step_index}`;
      pending.push(id);
      events.push({ seq: seq++, event: "tool_start", data: { id, name: call.name, input: normalizeAntigravityArgs(call.args) } });
    }
    // A GENERIC step is the harness reporting what the preceding call returned, in the
    // order the calls were made — that pairing is the only id the transcript offers.
    if (rec.type === "GENERIC" && pending.length) {
      events.push({ seq: seq++, event: "tool_result", data: { id: pending.shift(), output: rec.content || "" } });
      continue;
    }
    if (rec.content?.trim()) {
      events.push({ seq: seq++, event: "delta", data: { text: rec.content } });
      events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
    }
  }

  if (events.length === 0) return null;
  return tailFromLastUser(events);
}

// ── OpenCode: ~/.local/share/opencode/opencode.db (message + part tables) ──

export function recoverFromOpencodeTranscript(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    // A session belongs to the directory it ran in; resuming one from another project
    // would splice an unrelated conversation into this pane.
    const session = db.prepare("SELECT directory FROM session WHERE id = ?").get(sessionId);
    if (!session) return null;
    if (cwd && session.directory && path.resolve(session.directory) !== path.resolve(cwd)) return null;

    const parts = db.prepare(
      "SELECT p.message_id AS mid, p.data AS pdata, m.data AS mdata " +
      "FROM part p JOIN message m ON m.id = p.message_id " +
      "WHERE p.session_id = ? ORDER BY p.rowid"
    ).all(sessionId);
    if (!parts.length) return null;

    const events = [];
    let seq = 1;
    for (const row of parts) {
      let pd, md;
      try { pd = JSON.parse(row.pdata); md = JSON.parse(row.mdata); } catch { continue; }
      const role = md?.role;
      if (pd.type === "text" && typeof pd.text === "string" && pd.text.trim()) {
        if (role === "user") {
          if (isHarnessTurn(pd.text)) continue;
          const clean = stripHarnessWrapping(pd.text);
          if (!clean) continue;
          events.push({ seq: seq++, event: "user_message", data: { text: clean } });
        } else if (role === "assistant") {
          // The body is not a title: unwrap it, but never collapse or truncate it.
          const clean = stripHarnessWrapping(pd.text);
          if (!clean) continue;
          events.push({ seq: seq++, event: "delta", data: { text: clean } });
          events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
        }
      } else if (pd.type === "reasoning" && typeof pd.text === "string" && pd.text.trim()) {
        events.push({ seq: seq++, event: "thinking", data: { text: pd.text } });
      }
    }
    if (events.length === 0) return null;
    return tailFromLastUser(events);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

// Keep the tail only, and start it at a user turn so a replay never opens mid-reply.
function tailFromLastUser(events) {
  let slice = events.slice(-MAX_EVENTS);
  const firstUser = slice.findIndex((e) => e.event === "user_message");
  if (firstUser > 0) slice = slice.slice(firstUser);
  return slice.map((e, i) => ({ ...e, seq: i + 1 }));
}

/** Engine-dispatched transcript reader; null when the store has nothing for this id. */
export function recoverFromTranscript(engine, cwd, sessionId) {
  if (engine === "claude") return recoverFromClaudeTranscript(cwd, sessionId);
  if (engine === "codex") return recoverFromCodexTranscript(cwd, sessionId);
  if (engine === "opencode") return recoverFromOpencodeTranscript(cwd, sessionId);
  if (engine === "antigravity") return recoverFromAntigravityTranscript(cwd, sessionId);
  return null;
}
