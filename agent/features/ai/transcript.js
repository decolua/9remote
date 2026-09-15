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
import { stripHarnessWrapping, isInjectedTurn } from "../terminal/agentHistory.js";
import { recoverFromClaudeTranscript, CLAUDE_SESSION_ID_RE } from "./claudeTranscript.js";
import { codexItemEvents } from "./codexItems.js";
import { opencodePartEvents } from "./opencodePart.js";
import { toolStart, toolResult } from "./toolEvent.js";

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
// Two guards, because they answer different questions. `isHarnessTurn` is codex's own
// wrapper tags; `isInjectedTurn` is the shared one every reader uses for a turn the CLI
// wrote as if the user had typed it. Codex injects the project doc the same way Claude
// does, and without the second guard a reopened chat opened on `# AGENTS.md instructions`
// instead of the question that started it. Codex's developer-role messages (its skills
// and MCP instructions) are dropped separately: they carry no user text at all.
const isHarnessTurn = (text) => HARNESS_TURN_RE.test(text) || isInjectedTurn(text);

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
//
// The read itself is memoized too, and the cache is dropped when the file is replaced: a
// turn asks once per file it changes, so this ran a fresh full read of a file that grows
// all conversation long, and the same hydrate could land on a cached path with no cache
// behind it.
const codexRolloutCache = new Map();

function readRolloutLines(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = codexRolloutCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.lines;
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  codexRolloutCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
  return lines;
}

export function readCodexFileChanges(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = findCodexRollout(sessionId, cwd);
  if (!file) return null;

  const lines = readRolloutLines(file);
  if (!lines) return null;

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

  const lines = readRolloutLines(file);
  if (!lines) return null;

  const recs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch {}
  }

  // A tool call is written TWICE — once as an item (`item_completed`) and once as the
  // CLI's own `function_call` — and the two do NOT share an id: an `exec` call carries
  // `call_OsNL…` while the FileChange item it produced carries `exec-7336…`. Matching on
  // the id therefore missed them, and a reopened chat drew two cards for one edit.
  // Measured across every rollout on this machine: 45 of 363 had a duplicated card.
  //
  // So the two streams are merged by KIND and ORDER instead — both are written in call
  // order, and the item log is the richer record (it carries the patch and a command's
  // whole output). A fallback call consumes the next unclaimed item of its own kind and
  // is then dropped; the item's own card is what survives. Counts match whenever the CLI
  // logged both, so nothing is lost when they do not.
  const itemsAhead = new Map();
  const itemAt = new Map();
  const calls = [];
  for (let i = 0; i < recs.length; i++) {
    const p = recs[i].payload || {};
    if (recs[i].type === "event_msg" && p.type === "item_completed" && p.item) {
      const kind = codexToolKind(itemToolName(p.item));
      if (!itemsAhead.has(kind)) itemsAhead.set(kind, []);
      itemsAhead.get(kind).push(i);
      if (p.item.id) itemAt.set(p.item.id, i);
    } else if (recs[i].type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      calls.push({ at: i, id: p.call_id || p.id, kind: codexToolKind(p.name) });
    }
  }

  // Which item each call is already described by, resolved in two passes so an exact id
  // can never be stolen by a neighbour: the ids first (unambiguous, and free), then what
  // is left gets the nearest unclaimed item of its kind. Doing this in call order alone
  // let one call claim by proximity an item that another call matched by id.
  const claimed = new Set();
  const matchOf = new Map();
  for (const call of calls) {
    const j = itemAt.get(call.id);
    if (j === undefined || claimed.has(j)) continue;
    claimed.add(j);
    matchOf.set(call.at, j);
  }
  for (const call of calls) {
    if (matchOf.has(call.at)) continue;
    let pick;
    let best = Infinity;
    for (const j of itemsAhead.get(call.kind) || []) {
      if (claimed.has(j)) continue;
      const d = Math.abs(j - call.at);
      if (d < best) { best = d; pick = j; }
    }
    if (pick === undefined) continue;
    claimed.add(pick);
    matchOf.set(call.at, pick);
  }

  const events = [];
  let seq = 1;
  // id → the CLI call name, or "covered" once its own record is known to be a duplicate
  // of an item. Nothing is emitted for a covered one, so there is no event to drop later.
  const byCallId = new Map();
  const push = (ev) => events.push({ seq: seq++, ...ev });

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const p = rec.payload || {};

    // The rollout's own item log, read through the same mapper the live stream uses — so
    // a replayed card is the object a live one is.
    if (rec.type === "event_msg") {
      if (p.type === "item_completed" && p.item) for (const ev of codexItemEvents(p)) push(ev);
      continue;
    }

    if (rec.type !== "response_item") continue;

    if (p.type === "message") {
      // Only a real conversation is replayed: codex also writes its own skills and MCP
      // instructions as a `developer` message, which is not a turn anyone typed.
      if (p.role !== "user" && p.role !== "assistant") continue;
      const text = (p.content || [])
        .map((c) => c?.text || (typeof c === "string" ? c : ""))
        .join("");
      if (!text.trim()) continue;
      if (p.role === "user") {
        if (isHarnessTurn(text)) continue;
        const clean = stripHarnessWrapping(text);
        if (!clean) continue;
        events.push({ seq: seq++, event: "user_message", data: { text: clean } });
      } else {
        // The body is not a title: unwrap it, but never collapse or truncate it.
        const clean = stripHarnessWrapping(text);
        if (!clean) continue;
        events.push({ seq: seq++, event: "delta", data: { text: clean } });
        events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
      }
    } else if (p.type === "reasoning" && p.summary) {
      const text = p.summary.map((s) => s?.text || "").join("");
      if (text.trim()) events.push({ seq: seq++, event: "thinking", data: { text } });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const id = p.call_id || p.id;
      // An item already describes this call — its card is the one that survives, and the
      // result record that follows belongs to the same dropped call.
      if (matchOf.has(i)) {
        byCallId.set(id, "covered");
        continue;
      }
      byCallId.set(id, p.name || "");
      push(codexCallStart(id, p.name, p.arguments ?? p.input));
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const id = p.call_id || p.id;
      const name = byCallId.get(id) || "";
      byCallId.delete(id);
      if (name === "covered") continue;
      push(codexCallResult(id, name, p.output));
    }
  }

  if (events.length === 0) return null;
  return tailFromLastUser(events.map((e, i) => ({ ...e, seq: i + 1 })));
}

// ── Codex's fallback source: the `response_item` tool records ──
//
// These are the CLI's own function calls, not the item log: `arguments` is a JSON string
// (or, for a `custom_tool_call`, the script/patch itself), and the result is the paired
// `*_output`. Only two of the names map onto a card that says anything about them; every
// other call — an MCP tool, a goal read — keeps its own name and shows its arguments.
//
// A call and the item it produced are matched by what they DID, not by their ids, because
// the ids differ (`call_OsNL…` against `exec-7336…`). This is the one place that knows
// which of the CLI's call names lands in which item type; `codexItems.js` owns the other
// direction — the item type → the tool name the client sees.

/** The wire tool name an item type maps to, or "" when it is not a tool at all. */
function itemToolName(item) {
  return codexItemEvents({ ...item, status: "started" })[0]?.data?.name || "";
}

/** The wire tool name a CLI call name produces. */
function codexToolKind(name) {
  return name === "exec_command" || name === "shell" ? "command"
    : name === "apply_patch" || name === "exec" ? "file_change"
    : name || "tool";
}

/** Paths an apply_patch script names, in the order it names them. */
function patchPaths(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return out;
}

/** The same argument object the item log would have carried, for the two mapped names. */
function codexCallInput(name, raw) {
  if (name === "exec_command" || name === "shell") {
    let args = raw;
    try { args = JSON.parse(raw); } catch {}
    return { command: typeof args === "string" ? args : args?.cmd || args?.command || "" };
  }
  if (name === "apply_patch" || name === "exec") {
    const paths = patchPaths(raw);
    return paths.length ? { file_path: paths[0], path: paths[0], paths } : { input: String(raw || "") };
  }
  // An MCP call arrives as `mcp__<server>__<tool>`; its arguments are JSON.
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

function codexCallStart(id, name, raw) {
  return toolStart({ id, name: codexToolKind(name), input: codexCallInput(name, raw) });
}

function codexCallResult(id, name, output) {
  const tool = codexToolKind(name);
  // `custom_tool_call_output` carries content parts; a plain call carries a string.
  const text = Array.isArray(output) ? output.map((c) => c?.text || "").join("") : (output ?? "");
  return toolResult({ id, name: tool, output: typeof text === "string" ? text : JSON.stringify(text) });
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
      } else if (pd.type === "tool") {
        // The row is the part the live stream carried, verbatim — so the same mapper
        // reads it, and a reopened chat shows the tool cards the live one showed.
        for (const ev of opencodePartEvents(pd)) events.push({ seq: seq++, ...ev });
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
