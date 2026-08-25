// Conversation history of the coding CLIs themselves — each agent keeps its own
// transcript store, and this lists the ones belonging to a single cwd so a
// terminal can offer to resume a past conversation from where it is standing.
//
// Two source shapes. "cwdDir" agents encode the cwd into a directory name, so
// one readdir answers the question no matter how many sessions exist. "scan"
// agents bury the cwd inside the transcript, so their newest files are read
// head-first until the budget runs out.
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { HISTORY } from "./constants.js";
import { createRequire } from "module";
import { agentById } from "./agentCatalog.js";

const require = createRequire(import.meta.url);

const home = () => os.homedir();

// Injected preamble turns that are machinery, not something the user typed.
const WRAPPER_PATTERNS = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<timestamp>[\s\S]*?<\/timestamp>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g
];
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;
// Turns the harness writes into the transcript as if the user had typed them:
// slash commands and their output (Claude), and the project doc Codex injects
// ahead of the opening prompt. The real question is the turn after one of these.
const INJECTED_TURN_RES = [
  /^<(local-)?command-[a-z]+>/,
  /^# [A-Za-z0-9._-]+\.md instructions\b/
];
const isInjectedTurn = (text) => INJECTED_TURN_RES.some((re) => re.test(text));

// One transcript line's text, minus the harness wrapping, collapsed to one line.
function cleanTitle(text) {
  if (typeof text !== "string") return "";
  const query = text.match(USER_QUERY_RE);
  let out = query ? query[1] : text;
  for (const re of WRAPPER_PATTERNS) out = out.replace(re, "");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > HISTORY.TITLE_MAX ? `${out.slice(0, HISTORY.TITLE_MAX)}…` : out;
}

// Message content is a bare string in some stores and a content-part array in others.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join(" ");
}

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

// Transcript lines, read in chunks and yielded as they complete. Lazy because
// the interesting line is usually the first few, but Codex writes a
// multi-kilobyte instruction preamble ahead of the user's opening prompt — a
// fixed-size head would stop short of it. Both budgets are ceilings, not reads.
function* readLines(filePath, maxLines) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(HISTORY.CHUNK_BYTES);
    let rest = "";
    let lines = 0;
    for (let offset = 0; offset < HISTORY.HEAD_BYTES; offset += HISTORY.CHUNK_BYTES) {
      const read = fs.readSync(fd, buf, 0, HISTORY.CHUNK_BYTES, offset);
      if (!read) return;
      const parts = (rest + buf.subarray(0, read).toString("utf8")).split("\n");
      rest = parts.pop();
      for (const line of parts) {
        if (++lines > maxLines) return;
        yield line;
      }
      if (read < HISTORY.CHUNK_BYTES) break;
    }
    if (rest && lines < maxLines) yield rest;
  } finally {
    fs.closeSync(fd);
  }
}

function mtimeMs(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// --- cwd encoders ---

const dashEncode = (cwd) => cwd.replace(/[/\\:]/g, "-");
const sha256 = (cwd) => crypto.createHash("sha256").update(cwd).digest("hex");

// --- per-agent parsers: transcript head -> { sessionId, title, cwd } ---

function parseClaude(filePath) {
  let title = "";
  let custom = "";
  for (const line of readLines(filePath, HISTORY.HEAD_LINES)) {
    const rec = parseJson(line);
    if (!rec) continue;
    if (rec.type === "custom-title") custom = cleanTitle(rec.customTitle);
    else if (rec.type === "ai-title" && !custom) custom = cleanTitle(rec.aiTitle);
    else if (rec.type === "user" && !title && rec.isMeta !== true) {
      const text = contentText(rec.message?.content).trim();
      if (!isInjectedTurn(text)) title = cleanTitle(text);
    }
    if (custom) break;
  }
  return { sessionId: path.basename(filePath, ".jsonl"), title: custom || title };
}

function parseDroid(filePath) {
  for (const line of readLines(filePath, HISTORY.HEAD_LINES)) {
    const rec = parseJson(line);
    if (rec?.type === "session_start") {
      return { sessionId: rec.id || path.basename(filePath, ".jsonl"), title: cleanTitle(rec.title), cwd: rec.cwd };
    }
  }
  return { sessionId: path.basename(filePath, ".jsonl"), title: "" };
}

function parseCursor(filePath) {
  for (const line of readLines(filePath, HISTORY.HEAD_LINES)) {
    const rec = parseJson(line);
    if (rec?.role !== "user") continue;
    const title = cleanTitle(contentText(rec.message?.content ?? rec.content));
    if (title) return { sessionId: path.basename(filePath, ".jsonl"), title };
  }
  return { sessionId: path.basename(filePath, ".jsonl"), title: "" };
}

function parseCodex(filePath) {
  let sessionId = null;
  let cwd = null;
  let title = "";
  for (const line of readLines(filePath, HISTORY.HEAD_LINES)) {
    const rec = parseJson(line);
    if (!rec) continue;
    if (rec.type === "session_meta") {
      sessionId = rec.payload?.id || null;
      cwd = rec.payload?.cwd || null;
      continue;
    }
    if (title) continue;
    const payload = rec.payload;
    if (payload?.type === "message" && payload.role === "user") {
      const text = contentText(payload.content).trim();
      if (!isInjectedTurn(text)) title = cleanTitle(text);
    }
    if (title && sessionId) break;
  }
  return sessionId ? { sessionId, title, cwd } : null;
}

function parseWholeJson(filePath) {
  try { return parseJson(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

// OpenCode migrated its sessions from one JSON file each into a single SQLite
// db, and leaves the old storage/ tree in place — so the files alone are a
// months-old snapshot presented as current. Read the db first, fall back to the
// files, and let the db win where a session is in both.
//
// node:sqlite ships with Node 22.5+; an older runtime simply keeps the files.
let sqliteModule;
function loadSqlite() {
  if (sqliteModule === undefined) {
    try { sqliteModule = require("node:sqlite"); } catch { sqliteModule = null; }
  }
  return sqliteModule;
}

function opencodeDbRows(cwd) {
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  const dbPath = path.join(home(), ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    // Read-only: opencode may be writing to it right now, and this is a viewer.
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(
      // parent_id marks a spawned subagent — it resumes with its parent, not alone.
      "SELECT id, title, directory, time_updated FROM session " +
      "WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT ?"
    ).all(cwd, HISTORY.PER_AGENT_LIMIT);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function parseOpencode(filePath) {
  const data = parseWholeJson(filePath);
  if (!data?.id) return null;
  return {
    sessionId: data.id,
    title: cleanTitle(data.title),
    cwd: data.directory || null,
    updatedAt: data.time?.updated || null
  };
}

function parseGrok(filePath) {
  const data = parseWholeJson(filePath);
  const sessionId = data?.info?.id;
  if (!sessionId) return null;
  return { sessionId, title: cleanTitle(data.session_summary), cwd: data.info.cwd || null };
}

function parseGemini(filePath) {
  const data = parseWholeJson(filePath);
  if (!data?.sessionId) return null;
  const firstUser = (data.messages || []).find((m) => m.type === "user");
  return { sessionId: data.sessionId, title: cleanTitle(contentText(firstUser?.content)) };
}

// --- source registry ---
// cwdDir sources resolve one directory from the cwd; scan sources walk their
// newest files and keep the ones whose parsed cwd matches. `depth` is how many
// directory levels below the cwd directory the transcripts sit.

const HISTORY_SOURCES = [
  { id: "claude", layout: "cwdDir", root: () => path.join(home(), ".claude", "projects"), encode: dashEncode, ext: ".jsonl", parse: parseClaude },
  { id: "codex", layout: "scan", root: () => path.join(process.env.CODEX_HOME?.trim() || path.join(home(), ".codex"), "sessions"), ext: ".jsonl", parse: parseCodex },
  { id: "opencode", layout: "opencode", root: () => path.join(home(), ".local", "share", "opencode", "storage", "session"), ext: ".json", parse: parseOpencode },
  { id: "gemini", layout: "cwdDir", root: () => path.join(home(), ".gemini", "tmp"), encode: sha256, sub: "chats", ext: ".json", parse: parseGemini },
  { id: "qwen", layout: "cwdDir", root: () => path.join(home(), ".qwen", "tmp"), encode: sha256, sub: "chats", ext: ".json", parse: parseGemini },
  { id: "cursor", layout: "cwdDir", root: () => path.join(home(), ".cursor", "projects"), encode: dashEncode, sub: "agent-transcripts", depth: 1, ext: ".jsonl", parse: parseCursor },
  { id: "droid", layout: "cwdDir", root: () => path.join(home(), ".factory", "sessions"), encode: dashEncode, ext: ".jsonl", parse: parseDroid },
  { id: "grok", layout: "cwdDir", root: () => path.join(home(), ".grok", "sessions"), encode: encodeURIComponent, depth: 1, ext: ".json", file: "summary.json", parse: parseGrok }
];

const COLLECTORS = { cwdDir: collectCwdDir, scan: collectScan, opencode: collectOpencode };

const SOURCE_BY_ID = new Map(HISTORY_SOURCES.map((s) => [s.id, s]));
// Rank ties by the order the sources are declared — claude, codex, opencode first.
const SOURCE_RANK = new Map(HISTORY_SOURCES.map((s, i) => [s.id, i]));

/** The store directory name an agent derives from a cwd, or null when it doesn't use one. */
export function encodeCwdForAgent(agentId, cwd) {
  const source = SOURCE_BY_ID.get(agentId);
  if (!source?.encode) return null;
  return source.encode(cwd);
}

const SHELL_SAFE_RE = /^[A-Za-z0-9._\-/]+$/;

/**
 * Shell line that re-enters one past conversation, or null when the CLI has no
 * resume form. `skipPermissions` re-applies the CLI's own bypass flag: resuming
 * otherwise drops back to per-action approval, which is not where the user left off.
 */
export function resumeCommand(agentId, sessionId, skipPermissions = false) {
  const agent = agentById(agentId);
  if (!agent?.resume || !sessionId) return null;
  const arg = SHELL_SAFE_RE.test(sessionId) ? sessionId : `'${sessionId.replace(/'/g, "'\\''")}'`;
  const line = agent.resume(arg);
  return skipPermissions && agent.yolo ? `${line} ${agent.yolo}` : line;
}

// --- matching history rows against the terminals already running them ---

// Two prompts are the same turn when they read the same. One may be truncated
// (a status line carries only what fit), so a long enough prefix counts — short
// ones do not: "fix" prefixes far too much to mean anything.
const PROMPT_PREFIX_MIN = 24;

const normalizePrompt = (text) => String(text || "").trim().replace(/\s+/g, " ").toLowerCase();

function promptsMatch(rowText, liveText) {
  if (!rowText || !liveText) return false;
  if (rowText === liveText) return true;
  if (rowText.length < PROMPT_PREFIX_MIN || liveText.length < PROMPT_PREFIX_MIN) return false;
  return rowText.startsWith(liveText) || liveText.startsWith(rowText);
}

/**
 * Tag each history row with the terminal already running it, so the UI can focus
 * that terminal instead of resuming a second copy of the same conversation.
 *
 * A reported conversation id is proof and settles the row. Without one, the
 * opening prompt is the next best signal, then the transcript clock: a terminal
 * running agent A in cwd C since T can only be the transcript of A in C that
 * started writing after T. Both are inference, so each claims a row only when
 * exactly one terminal could be meant. Two plausible terminals leave the row
 * unclaimed: opening a duplicate is a smaller wrong than focusing someone
 * else's conversation.
 */

// mtime and the terminal clock are the same machine clock, so "written after
// the terminal started" needs no slack.
const LAUNCH_SKEW_MS = 0;
export function matchLiveSessions(rows, liveTerminals = []) {
  const claimed = new Set();
  const byId = new Map();
  for (const live of liveTerminals) {
    if (live?.conversationId) byId.set(`${live.agent}:${live.conversationId}`, live.sessionId);
  }

  const tagged = rows.map((row) => {
    const openSessionId = byId.get(`${row.agent}:${row.sessionId}`) || null;
    if (openSessionId) claimed.add(openSessionId);
    return { ...row, openSessionId };
  });

  for (const row of tagged) {
    if (row.openSessionId) continue;
    const rowText = normalizePrompt(row.title);
    if (!rowText) continue;
    const candidates = liveTerminals.filter(
      (live) => live.agent === row.agent && !claimed.has(live.sessionId) &&
        promptsMatch(rowText, normalizePrompt(live.prompt))
    );
    if (candidates.length === 1) {
      row.openSessionId = candidates[0].sessionId;
      claimed.add(row.openSessionId);
    }
  }

  for (const row of tagged) {
    if (row.openSessionId || !row.cwd) continue;
    const candidates = liveTerminals.filter(
      (live) => live.agent === row.agent && !claimed.has(live.sessionId) &&
        live.startedAt && live.cwd === row.cwd && row.updatedAt >= live.startedAt - LAUNCH_SKEW_MS
    );
    if (candidates.length === 1) {
      row.openSessionId = candidates[0].sessionId;
      claimed.add(row.openSessionId);
    }
  }
  return tagged;
}

// Files directly under `dir`, descending `depth` levels of subdirectories first.
function filesUnder(dir, depth, ext, fileName) {
  const out = [];
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) out.push(...filesUnder(full, depth - 1, ext, fileName));
      continue;
    }
    if (fileName ? entry.name !== fileName : !entry.name.endsWith(ext)) continue;
    // .settings.json siblings shadow the transcript they describe.
    if (!fileName && entry.name.endsWith(`.settings${ext}`)) continue;
    out.push(full);
  }
  return out;
}

function collectCwdDir(source, cwd, limit) {
  const base = path.join(source.root(), source.encode(cwd), source.sub || "");
  const rows = [];
  for (const filePath of filesUnder(base, source.depth || 0, source.ext, source.file)) {
    const parsed = source.parse(filePath);
    if (!parsed?.sessionId) continue;
    rows.push({ ...parsed, filePath });
  }
  return byNewest(rows, source, cwd).slice(0, limit);
}

// OpenCode's two stores, db first, each session listed once.
function collectOpencode(source, cwd, limit) {
  const rows = opencodeDbRows(cwd).map((r) => ({
    sessionId: r.id,
    title: cleanTitle(r.title),
    cwd: r.directory,
    updatedAt: r.time_updated
  }));
  const seen = new Set(rows.map((r) => r.sessionId));
  for (const row of collectScan(source, cwd, limit)) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    rows.push({ sessionId: row.sessionId, title: row.title, cwd: row.cwd, updatedAt: row.updatedAt });
  }
  return byNewest(rows, source, cwd).slice(0, limit);
}

function collectScan(source, cwd, limit) {
  const files = filesUnder(source.root(), HISTORY.SCAN_DEPTH, source.ext, source.file)
    .map((filePath) => ({ filePath, mtime: mtimeMs(filePath) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, HISTORY.SCAN_FILE_CAP);

  const rows = [];
  for (const { filePath } of files) {
    const parsed = source.parse(filePath);
    if (!parsed?.sessionId || parsed.cwd !== cwd) continue;
    rows.push({ ...parsed, filePath });
    if (rows.length >= limit) break;
  }
  return byNewest(rows, source, cwd);
}

function byNewest(rows, source, cwd) {
  return rows
    .map((row) => ({
      agent: source.id,
      sessionId: row.sessionId,
      title: row.title || "",
      cwd: row.cwd || cwd,
      updatedAt: row.updatedAt || mtimeMs(row.filePath),
      resume: resumeCommand(source.id, row.sessionId)
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Title one conversation carries, from the rows already collected for its cwd.
 * Cheap on purpose: it reads the same 30s cache the sidebar fills, so naming a
 * terminal after its chat costs no extra transcript reads.
 */
export function conversationTitle(agent, conversationId, cwd) {
  if (!agent || !conversationId || !cwd) return "";
  const cached = cache.get(cwd);
  if (!cached) return "";
  const row = cached.rows.find((r) => r.agent === agent && r.sessionId === conversationId);
  return row?.title || "";
}

// Keyed by cwd — a terminal that cd's elsewhere asks a different question.
const cache = new Map();

export function clearHistoryCache() {
  cache.clear();
}

/**
 * Past conversations of every detected agent CLI that ran in `cwd`, newest first.
 * Absent stores are skipped silently: not having an agent installed is normal.
 */
export async function listAgentSessions({ cwd, limit = HISTORY.DEFAULT_LIMIT, fresh = false } = {}) {
  if (!cwd) return [];
  const cached = cache.get(cwd);
  // `fresh` is for a caller that knows the cache predates what it is looking for
  // — a conversation whose transcript was written after the last scan.
  if (!fresh && cached && Date.now() - cached.at < HISTORY.CACHE_TTL_MS) return cached.rows.slice(0, limit);

  const rows = [];
  for (const source of HISTORY_SOURCES) {
    const collect = COLLECTORS[source.layout];
    rows.push(...collect(source, cwd, HISTORY.PER_AGENT_LIMIT));
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt || SOURCE_RANK.get(a.agent) - SOURCE_RANK.get(b.agent));

  cache.set(cwd, { at: Date.now(), rows });
  return rows.slice(0, limit);
}
