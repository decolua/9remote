// Rebuilds past codex/opencode conversations from CLI stores for resume history.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { stripHarnessWrapping, isInjectedTurn } from "../terminal/agentHistory.js";
import { recoverFromClaudeTranscript, CLAUDE_SESSION_ID_RE } from "./claudeTranscript.js";
import { codexItemEvents } from "./codexItems.js";
import { opencodePartEvents, diffFor } from "./opencodePart.js";
import { antigravityEditDiff, ANTIGRAVITY_PARAM_ALIASES, ANTIGRAVITY_HEADLESS_NOTE_RE } from "./adapters/antigravityAdapter.js";
import { toolStart, toolResult } from "./toolEvent.js";

const require = createRequire(import.meta.url);

const MAX_EVENTS = 200;

// node:sqlite requires Node 22.5+; yields null on older runtimes.
let sqliteModule;
function loadSqlite() {
  if (sqliteModule === undefined) {
    try { sqliteModule = require("node:sqlite"); } catch { sqliteModule = null; }
  }
  return sqliteModule;
}

const HARNESS_TURN_RE = /^\s*<(environment_context|turn_aborted)>/;
// Filter out harness/injected turns to prevent synthetic prompts appearing as user messages.
const isHarnessTurn = (text) => HARNESS_TURN_RE.test(text) || isInjectedTurn(text);

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ──

// Memoize rollout paths since thread IDs map 1:1 to immutable rollout files.
const rolloutPathCache = new Map();

function findCodexRollout(sessionId, cwd) {
  const key = `${cwd}\n${sessionId}`;
  if (rolloutPathCache.has(key)) return rolloutPathCache.get(key);

  const root = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(root, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  // Match exact suffix to prevent short session IDs matching unintended files.
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

// Validate cwd in session_meta so same-named sessions from other projects are rejected.
function rolloutMatchesCwd(file, cwd) {
  try {
    const first = fs.readFileSync(file, "utf8").split("\n", 1)[0];
    const rec = JSON.parse(first);
    return !rec?.payload?.cwd || sameDir(rec.payload.cwd, cwd);
  } catch {
    return true;
  }
}

// Compare canonical realpaths to handle macOS symlinks (e.g. /tmp -> /private/tmp).
function sameDir(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// Cache rollout lines keyed by mtime/size to avoid re-reading growing rollout files.
// Bounded, LRU: whole-file line arrays are heavy, and an unbounded map is a slow leak.
const ROLLOUT_CACHE_MAX = 24;
const codexRolloutCache = new Map();

function readRolloutLines(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = codexRolloutCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    codexRolloutCache.delete(file);
    codexRolloutCache.set(file, hit);
    return hit.lines;
  }
  let lines;
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n"); } catch { return null; }
  codexRolloutCache.delete(file);
  codexRolloutCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
  if (codexRolloutCache.size > ROLLOUT_CACHE_MAX) {
    codexRolloutCache.delete(codexRolloutCache.keys().next().value);
  }
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

// Rollout file contains parsed_cmd omitted from the live exec --json stream.
export function readCodexParsedCommands(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = findCodexRollout(sessionId, cwd);
  if (!file) return null;

  const lines = readRolloutLines(file);
  if (!lines) return null;

  const out = {};
  for (const line of lines) {
    if (!line.includes("parsed_cmd")) continue;
    let item;
    try { item = JSON.parse(line).payload?.item; } catch { continue; }
    if (item?.id && Array.isArray(item.parsed_cmd)) out[item.id] = item.parsed_cmd;
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

  // Merge tool calls and item_completed by kind/order to deduplicate mismatched IDs.
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

  // Match calls to items by ID first, then fallback to nearest unclaimed item by kind.
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
  // Tracks call names or "covered" marker for deduplicated items.
  const byCallId = new Map();
  const push = (ev) => events.push({ seq: seq++, ...ev });

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const p = rec.payload || {};

    if (rec.type === "event_msg") {
      if (p.type === "item_completed" && p.item) for (const ev of codexItemEvents(p)) push(ev);
      continue;
    }

    if (rec.type !== "response_item") continue;

    if (p.type === "message") {
      // Skip developer-role messages (skills and MCP instructions).
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
      // Skip function call if an item already describes it.
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
// Maps raw response_item function calls to wire tool events when items are absent.

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
  const text = Array.isArray(output) ? output.map((c) => c?.text || "").join("") : (output ?? "");
  return toolResult({ id, name: tool, output: typeof text === "string" ? text : JSON.stringify(text) });
}

// Normalize Antigravity PascalCase tool parameters to lowercase wire names — the shared
// map lives in the adapter, so the live stream and this recovery read agree on one shape.
function normalizeAntigravityArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    // Strip enclosing quotes from compact transcript values.
    const clean = typeof value === "string" && value.startsWith('"')
      ? value.replace(/^"|"$/g, "")
      : value;
    out[ANTIGRAVITY_PARAM_ALIASES[key] || key] = clean;
  }
  return out;
}

// ── Antigravity: ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl ──
export function recoverFromAntigravityTranscript(cwd, sessionId) {
  // Validate sessionId before using as path segment; cwd is ignored (store is keyed by ID).
  if (!sessionId || !CLAUDE_SESSION_ID_RE.test(sessionId)) return null;
  const root = process.env.ANTIGRAVITY_HOME?.trim() || path.join(os.homedir(), ".gemini", "antigravity-cli");
  const logsDir = path.join(root, "brain", sessionId, ".system_generated", "logs");
  // Prefer transcript_full.jsonl over quoted transcript.jsonl when present.
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
  const pending = [];
  let seq = 1;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === "USER_INPUT") {
      // Strip harness context wrapper, then the adapter's own headless note — the bubble
      // must show what the user typed, not the plumbing that rode along.
      const text = stripHarnessWrapping(rec.content || "").replace(ANTIGRAVITY_HEADLESS_NOTE_RE, "");
      if (text) events.push({ seq: seq++, event: "user_message", data: { text } });
      continue;
    }
    if (rec.type !== "PLANNER_RESPONSE" && rec.type !== "GENERIC") continue;

    if (rec.thinking?.trim()) events.push({ seq: seq++, event: "thinking", data: { text: rec.thinking } });

    const calls = rec.tool_calls || [];
    for (const call of calls) {
      const id = `${call.name}-${rec.step_index}`;
      pending.push({ id, call });
      events.push({ seq: seq++, event: "tool_start", data: { id, name: call.name, input: normalizeAntigravityArgs(call.args) } });
    }
    // GENERIC step pairs with the oldest pending tool call in FIFO order.
    if (rec.type === "GENERIC" && pending.length) {
      const settled = pending.shift();
      events.push({ seq: seq++, event: "tool_result", data: { id: settled.id, output: rec.content || "" } });
      // Emit diff event for landed edits matching live stream behavior.
      const diff = antigravityEditDiff(settled.call.name, normalizeAntigravityArgs(settled.call.args));
      if (diff) events.push({ seq: seq++, event: "diff", data: diff });
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
    // Validate session directory matches cwd to prevent cross-project resume.
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
          const clean = stripHarnessWrapping(pd.text);
          if (!clean) continue;
          events.push({ seq: seq++, event: "delta", data: { text: clean } });
          events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
        }
      } else if (pd.type === "reasoning" && typeof pd.text === "string" && pd.text.trim()) {
        events.push({ seq: seq++, event: "thinking", data: { text: pd.text } });
      } else if (pd.type === "tool") {
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


// omp (oh-my-pi) sessions are append-only JSONL under ~/.omp/agent/sessions:
// a {type:"session", id, cwd} header, then {type:"message", message:{role,
// content}} entries (measured on 18.2.6). The pane replays the same cards the
// live adapter drew: text, thinking, tool calls/results and write diffs.
export function recoverFromOmpTranscript(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const root = path.join(os.homedir(), ".omp", "agent", "sessions");
  if (!fs.existsSync(root)) return null;
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 4 || candidates.length > 200) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const full = path.join(dir, n.name);
      if (n.isDirectory()) walk(full, depth + 1);
      else if (n.name.endsWith(".jsonl")) candidates.push(full);
    }
  };
  walk(root, 0);
  let file = null;
  for (const f of candidates) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n").slice(0, 5)) {
        const rec = JSON.parse(line);
        if (rec?.type === "session" && rec.id === sessionId) {
          // Same rule as the opencode reader: no cross-project resume.
          if (cwd && rec.cwd && path.resolve(rec.cwd) !== path.resolve(cwd)) return null;
          file = f;
          break;
        }
      }
    } catch {}
    if (file) break;
  }
  if (!file) return null;

  const events = [];
  const argsById = new Map();
  const textOf = (content) => typeof content === "string"
    ? content
    : (Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("") : "");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== "message") continue;
    const msg = rec.message || {};
    if (msg.role === "user") {
      const text = textOf(msg.content);
      if (text.trim()) events.push({ event: "user_message", data: { text } });
    } else if (msg.role === "assistant") {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        if (part?.type === "text" && part.text) {
          events.push({ event: "delta", data: { text: part.text } });
          events.push({ event: "turn_complete", data: { stats: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 1 }, result: "", isError: false, subtype: "" } });
        } else if (part?.type === "thinking" && part.thinking) {
          events.push({ event: "thinking", data: { text: part.thinking } });
        } else if (part?.type === "toolCall" && part.id) {
          argsById.set(part.id, part);
          events.push({ event: "tool_start", data: { id: part.id, name: part.name || "tool", input: part.arguments || {}, status: "running" } });
        }
      }
    } else if (msg.role === "toolResult") {
      const args = argsById.get(msg.toolCallId);
      const failed = Boolean(msg.isError);
      const output = textOf(msg.content);
      events.push({ event: "tool_result", data: failed
        ? { id: msg.toolCallId, name: msg.toolName || "tool", error: output || "Tool failed.", status: "error" }
        : { id: msg.toolCallId, name: msg.toolName || "tool", output, status: "done" } });
      if (!failed && args && (msg.toolName === "write" || msg.toolName === "edit")) {
        const diff = diffFor(msg.toolName, args.arguments || {});
        if (diff) events.push({ event: "diff", data: diff });
      }
    }
  }
  return events.length ? events : null;
}

// Devin keeps conversations in a SQLite node chain (sessions.db message_nodes);
// every process spawn re-parents a fresh copy, so the rows alone would show the
// same turns many times. The NEWEST node's parent chain is the whole
// conversation as the CLI itself holds it. Text-only v1: tool calls stay in the TUI.
export function recoverFromDevinTranscript(sessionId) {
  if (!sessionId) return null;
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const dbPath = path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id ASC"
    ).all(sessionId);
    if (!rows.length) return null;
    // Walk the newest node's parents to the root — that chain is the latest full copy.
    const byId = new Map(rows.map((r) => [r.node_id, r]));
    const chain = [];
    let cur = rows[rows.length - 1];
    while (cur && chain.length < MAX_EVENTS) {
      chain.push(cur);
      cur = cur.parent_node_id == null ? null : byId.get(cur.parent_node_id);
    }
    chain.reverse();

    const events = [];
    for (const row of chain) {
      let msg = null;
      try { msg = JSON.parse(row.chat_message || ""); } catch { continue; }
      const text = String(msg?.content || "").trim();
      if (!text || msg?.role === "system") continue;
      if (msg.role === "user") {
        // Pasted images ride as "[Image N: path]" lines — the file is gone by resume time.
        const clean = text.split("\n").filter((l) => !/^\[Image \d+:/.test(l)).join("\n").trim();
        if (clean && !isInjectedTurn(clean)) events.push({ event: "user_message", data: { text: clean } });
      } else if (msg.role === "assistant") {
        events.push({ event: "delta", data: { text } });
        events.push({ event: "turn_complete", data: { stats: { inputTokens: 0, outputTokens: 0, totalTurns: 1 }, result: "", isError: false, subtype: "end_turn" } });
      }
    }
    return events.length ? events : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

// Hermes keeps the conversation in state.db (messages table) — resume replays the
// chat rows; reasoning rides the thought column, tool rows stay out like devin's.
export function recoverFromHermesTranscript(sessionId) {
  if (!sessionId) return null;
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const dbPath = path.join(os.homedir(), ".hermes", "state.db");
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT role, content, reasoning FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?"
    ).all(sessionId, MAX_EVENTS);
    const events = [];
    for (const row of rows) {
      const text = typeof row?.content === "string" ? row.content.trim() : "";
      const thought = typeof row?.reasoning === "string" ? row.reasoning.trim() : "";
      if (row.role === "user") {
        if (text && !isInjectedTurn(text)) events.push({ event: "user_message", data: { text } });
      } else if (row.role === "assistant") {
        if (thought) events.push({ event: "thinking", data: { text: thought } });
        if (text) {
          events.push({ event: "delta", data: { text } });
          events.push({ event: "turn_complete", data: { stats: { inputTokens: 0, outputTokens: 0, totalTurns: 1 }, result: "", isError: false, subtype: "end_turn" } });
        }
      }
    }
    return events.length ? events : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

// Dispatches transcript recovery by engine; leafOverride is Claude-specific for rewind.
export function recoverFromTranscript(engine, cwd, sessionId, leafOverride = null) {
  if (engine === "claude") return recoverFromClaudeTranscript(cwd, sessionId, 1, leafOverride);
  if (engine === "codex") return recoverFromCodexTranscript(cwd, sessionId);
  if (engine === "opencode") return recoverFromOpencodeTranscript(cwd, sessionId);
  if (engine === "antigravity") return recoverFromAntigravityTranscript(cwd, sessionId);
  if (engine === "omp") return recoverFromOmpTranscript(cwd, sessionId);
  if (engine === "devin") return recoverFromDevinTranscript(sessionId);
  if (engine === "hermes") return recoverFromHermesTranscript(sessionId);
  return null;
}
