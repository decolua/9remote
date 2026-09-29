// Aggregates conversation history from agent CLI transcript stores by cwd.
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { HISTORY } from "./constants.js";
import { createRequire } from "module";
import { writeJsonAtomic } from "../../lib/atomicFile.js";
import { agentById } from "./agentCatalog.js";
import { getConversationMode, engineFromAgent } from "./conversationModes.js";
import { parseWorktreeList } from "../fileExplorer/gitRepoScan.js";
import { findGitRoot } from "./workspaceMigration.js";

const require = createRequire(import.meta.url);

const home = () => os.homedir();

const WRAPPER_PATTERNS = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<timestamp>[\s\S]*?<\/timestamp>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g
];
const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;
const INJECTED_TURN_RES = [
  /^<(local-)?command-[a-z]+>/,
  /^# [A-Za-z0-9._-]+\.md instructions\b/,
  /^\s*\[Request interrupted by user\b/
];
export const isInjectedTurn = (text) => INJECTED_TURN_RES.some((re) => re.test(text));

export function cleanTitle(text) {
  const out = stripHarnessWrapping(text);
  const oneLine = out.replace(/\s+/g, " ");
  return oneLine.length > HISTORY.TITLE_MAX ? `${oneLine.slice(0, HISTORY.TITLE_MAX)}…` : oneLine;
}

export function stripHarnessWrapping(text) {
  if (typeof text !== "string") return "";
  const query = text.match(USER_QUERY_RE) || text.match(USER_REQUEST_RE);
  let out = query ? query[1] : text;
  for (const re of WRAPPER_PATTERNS) out = out.replace(re, "");
  return out.trim();
}

// Hermes titles its own sessions in state.db (sessions.title) a beat after the
// turn ends — the pane header adopts it the way the TUI does.
// One opener for both sides of the same table; null when there is nothing to open.
function hermesDb(readOnly) {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(home(), ".hermes", "state.db");
  if (!fs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath, { readOnly });
}

export function readHermesSessionTitle(sessionId) {
  if (!sessionId) return "";
  try {
    const db = hermesDb(true);
    if (!db) return "";
    try {
      const row = db.prepare("SELECT title FROM sessions WHERE id = ?").get(sessionId);
      return String(row?.title || "").trim();
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

// The write side of the same table hermes' manual /title lands in: source 'user'
// outranks its auto-titler, so the name sticks without touching the live process.
export function renameHermesSession(sessionId, title) {
  if (!sessionId || !title) return false;
  try {
    const db = hermesDb(false);
    if (!db) return false;
    try {
      // changes>0: an id that matched nothing renamed nothing — not a success.
      const res = db.prepare("UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?").run(title, sessionId);
      return res.changes > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).filter(Boolean).join(" ");
}

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

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

function fileSizeBytes(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

const dashEncode = (cwd) => cwd.replace(/[/\\:]/g, "-");
const sha256 = (cwd) => crypto.createHash("sha256").update(cwd).digest("hex");

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

// OpenCode uses SQLite (Node 22.5+); fall back to file storage if unavailable.
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
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(
      // Skip subagents (parent_id is set).
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

function antigravityIndexPath() {
  return path.join(home(), ".gemini", "antigravity-cli", "cache", "conversation_metadata.json");
}

function antigravityEntryCwd(summary) {
  const uri = summary?.WorkspaceURIs?.[0];
  if (typeof uri !== "string") return null;
  try { return decodeURIComponent(uri.replace(/^file:\/\//, "")); } catch { return null; }
}

function antigravityDbRows(cwd) {
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  const dbPath = path.join(home(), ".gemini", "antigravity-cli", "conversation_summaries.db");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    let lastIdForCwd = null;
    try {
      const lastMap = parseWholeJson(path.join(home(), ".gemini", "antigravity-cli", "cache", "last_conversations.json"));
      lastIdForCwd = lastMap?.[cwd] || null;
    } catch {}

    const knownIds = new Set();
    if (lastIdForCwd) knownIds.add(lastIdForCwd);
    const histPath = path.join(home(), ".gemini", "antigravity-cli", "history.jsonl");
    if (fs.existsSync(histPath)) {
      for (const line of readLines(histPath, 100)) {
        const item = parseJson(line);
        if (item?.conversationId && item.workspace === cwd) knownIds.add(item.conversationId);
      }
    }

    const records = db.prepare(
      "SELECT conversation_id, title, preview, last_modified_time, workspace_uris FROM conversation_summaries " +
      "ORDER BY last_modified_time DESC LIMIT 100"
    ).all();

    const rows = [];
    for (const rec of records) {
      const id = rec.conversation_id;
      if (!id) continue;
      let matchesCwd = knownIds.has(id);
      if (!matchesCwd && rec.workspace_uris) {
        try {
          const uris = JSON.parse(rec.workspace_uris);
          if (Array.isArray(uris)) {
            matchesCwd = uris.some((u) => decodeURIComponent(String(u).replace(/^file:\/\//, "")) === cwd);
          }
        } catch {
          matchesCwd = rec.workspace_uris.includes(cwd);
        }
      }
      if (!matchesCwd) continue;
      rows.push({
        sessionId: id,
        title: cleanTitle(rec.title || rec.preview),
        cwd,
        updatedAt: Date.parse(rec.last_modified_time) || 0
      });
    }
    return rows;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function antigravityRows(cwd) {
  const seen = new Set();
  const rows = [];
  for (const r of antigravityDbRows(cwd)) {
    if (r.sessionId && !seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      rows.push(r);
    }
  }

  const index = parseWholeJson(antigravityIndexPath());
  for (const [id, entry] of Object.entries(index?.conversations || {})) {
    const summary = entry?.summary;
    const sessionId = summary?.ID || id;
    if (!sessionId || seen.has(sessionId)) continue;
    if (antigravityEntryCwd(summary) !== cwd) continue;
    seen.add(sessionId);
    rows.push({
      sessionId,
      title: cleanTitle(summary.Title || summary.Preview),
      cwd,
      updatedAt: Date.parse(summary.UpdatedAt) || Date.parse(entry.last_modified_time) || 0
    });
  }
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function antigravityDelete(sessionId) {
  let deleted = false;
  const indexPath = antigravityIndexPath();
  const index = parseWholeJson(indexPath);
  if (index?.conversations?.[sessionId]) {
    delete index.conversations[sessionId];
    try {
      writeJsonAtomic(indexPath, index);
      deleted = true;
    } catch {}
  }
  const sqlite = loadSqlite();
  if (sqlite) {
    const dbPath = path.join(home(), ".gemini", "antigravity-cli", "conversation_summaries.db");
    if (fs.existsSync(dbPath)) {
      let db;
      try {
        db = new sqlite.DatabaseSync(dbPath);
        const res = db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(sessionId);
        if (res.changes > 0) deleted = true;
      } catch {} finally {
        try { db?.close(); } catch {}
      }
    }
  }
  return deleted;
}

function parseCwdChats(filePath) {
  const data = parseWholeJson(filePath);
  if (!data?.sessionId) return null;
  const firstUser = (data.messages || []).find((m) => m.type === "user");
  return { sessionId: data.sessionId, title: cleanTitle(contentText(firstUser?.content)) };
}


/** omp (oh-my-pi): JSONL under ~/.omp/agent/sessions — session header carries id+cwd. */
function parseOmp(filePath) {
  let sessionId = null;
  let cwd = null;
  let title = "";
  for (const line of readLines(filePath, HISTORY.HEAD_LINES)) {
    const rec = parseJson(line);
    if (!rec) continue;
    if (rec.type === "session") {
      sessionId = rec.id || null;
      cwd = rec.cwd || null;
      continue;
    }
    if (rec.type === "title" && rec.title) {
      title = cleanTitle(String(rec.title));
      continue;
    }
    if (title && sessionId) break;
    if (rec.type === "message" && rec.message?.role === "user" && !title) {
      const text = contentText(rec.message.content).trim();
      if (text && !isInjectedTurn(text)) title = cleanTitle(text);
    }
  }
  return sessionId ? { sessionId, title: title || "OMP session", cwd } : null;
}

const HISTORY_SOURCES = [
  { id: "claude", layout: "cwdDir", root: () => path.join(home(), ".claude", "projects"), encode: dashEncode, ext: ".jsonl", parse: parseClaude },
  { id: "codex", layout: "scan", root: () => path.join(process.env.CODEX_HOME?.trim() || path.join(home(), ".codex"), "sessions"), ext: ".jsonl", parse: parseCodex },
  { id: "opencode", layout: "opencode", root: () => path.join(home(), ".local", "share", "opencode", "storage", "session"), ext: ".json", parse: parseOpencode },
  { id: "qwen-code", layout: "cwdDir", root: () => path.join(home(), ".qwen", "tmp"), encode: sha256, sub: "chats", ext: ".json", parse: parseCwdChats },
  { id: "cursor", layout: "cwdDir", root: () => path.join(home(), ".cursor", "projects"), encode: dashEncode, sub: "agent-transcripts", depth: 1, ext: ".jsonl", parse: parseCursor },
  { id: "droid", layout: "cwdDir", root: () => path.join(home(), ".factory", "sessions"), encode: dashEncode, ext: ".jsonl", parse: parseDroid },
  { id: "grok", layout: "cwdDir", root: () => path.join(home(), ".grok", "sessions"), encode: encodeURIComponent, depth: 1, ext: ".json", file: "summary.json", parse: parseGrok },
  { id: "antigravity", layout: "antigravity", root: () => path.join(home(), ".gemini", "antigravity-cli") },
  { id: "omp", layout: "scan", root: () => path.join(home(), ".omp", "agent", "sessions"), ext: ".jsonl", parse: parseOmp },
  { id: "devin", layout: "devin", root: () => path.join(home(), ".local", "share", "devin", "cli") },
  { id: "hermes", layout: "hermes", root: () => path.join(home(), ".hermes") }
];

const COLLECTORS = { cwdDir: collectCwdDir, scan: collectScan, opencode: collectOpencode, antigravity: collectAntigravity, devin: collectDevin, hermes: collectHermes };

const SOURCE_BY_ID = new Map(HISTORY_SOURCES.map((s) => [s.id, s]));
const SOURCE_RANK = new Map(HISTORY_SOURCES.map((s, i) => [s.id, i]));

export function encodeCwdForAgent(agentId, cwd) {
  const source = SOURCE_BY_ID.get(agentId);
  if (!source?.encode) return null;
  return source.encode(cwd);
}

const SHELL_SAFE_RE = /^[A-Za-z0-9._\-/]+$/;

export function resumeCommand(agentId, sessionId, skipPermissions = false) {
  const agent = agentById(agentId);
  if (!agent?.resume || !sessionId) return null;
  const arg = SHELL_SAFE_RE.test(sessionId) ? sessionId : `'${sessionId.replace(/'/g, "'\\''")}'`;
  const line = agent.resume(arg);
  return skipPermissions && agent.yolo ? `${line} ${agent.yolo}` : line;
}

const PROMPT_PREFIX_MIN = 24;

const normalizePrompt = (text) => String(text || "").trim().replace(/\s+/g, " ").toLowerCase();

function promptsMatch(rowText, liveText) {
  if (!rowText || !liveText) return false;
  if (rowText === liveText) return true;
  if (rowText.length < PROMPT_PREFIX_MIN || liveText.length < PROMPT_PREFIX_MIN) return false;
  return rowText.startsWith(liveText) || liveText.startsWith(rowText);
}

const LAUNCH_SKEW_MS = 0;
export function matchLiveSessions(rows, liveTerminals = []) {
  const claimed = new Set();
  const byId = new Map();
  for (const live of liveTerminals) {
    if (live?.conversationId) byId.set(`${engineFromAgent(live.agent)}:${live.conversationId}`, live.sessionId);
  }

  const tagged = rows.map((row) => {
    const openSessionId = byId.get(`${row.agent}:${row.sessionId}`) || null;
    if (openSessionId) claimed.add(openSessionId);
    const mode = getConversationMode(row.agent, row.sessionId);
    return { ...row, openSessionId, ...(mode ? { mode } : {}) };
  });

  for (const row of tagged) {
    if (row.openSessionId) continue;
    const rowText = normalizePrompt(row.title);
    if (!rowText) continue;
    const candidates = liveTerminals.filter(
      (live) => engineFromAgent(live.agent) === row.agent && !claimed.has(live.sessionId) &&
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
      (live) => engineFromAgent(live.agent) === row.agent && !claimed.has(live.sessionId) &&
        live.startedAt && live.cwd === row.cwd && row.updatedAt >= live.startedAt - LAUNCH_SKEW_MS
    );
    if (candidates.length === 1) {
      row.openSessionId = candidates[0].sessionId;
      claimed.add(row.openSessionId);
    }
  }
  return tagged;
}

function filesUnder(dir, depth, ext, fileName) {
  const out = [];
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) out.push(...filesUnder(full, depth - 1, ext, fileName));
      continue;
    }
    if (fileName ? entry.name !== fileName : !entry.name.endsWith(ext)) continue;
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

function devinDbRows(cwd) {
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  const dbPath = path.join(home(), ".local", "share", "devin", "cli", "sessions.db");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const records = db.prepare(
      "SELECT id, title, working_directory, last_activity_at FROM sessions " +
      "WHERE working_directory = ? AND (hidden = 0 OR hidden IS NULL) " +
      "ORDER BY last_activity_at DESC LIMIT ?"
    ).all(cwd, HISTORY.PER_AGENT_LIMIT);
    return records.map((r) => ({
      sessionId: r.id,
      title: cleanTitle(r.title),
      cwd: r.working_directory || cwd,
      updatedAt: (r.last_activity_at || 0) * 1000
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function collectDevin(source, cwd, limit) {
  const rows = devinDbRows(cwd);
  return byNewest(rows, source, cwd).slice(0, limit);
}

function hermesDbRows(cwd) {
  const sqlite = loadSqlite();
  if (!sqlite) return [];
  const dbPath = path.join(home(), ".hermes", "state.db");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const cols = db.prepare("PRAGMA table_info(sessions)").all();
    // Pre-0.11 state.db has no cwd column and nothing else carries it — the
    // honest list is the RECENT sessions (every project), not an empty one.
    // Rows with no title are background/worker sessions, not conversations.
    const [stmt, args] = cols.some((c) => c.name === "cwd")
      ? [db.prepare("SELECT id, title, started_at FROM sessions WHERE cwd = ? AND title != '' ORDER BY started_at DESC LIMIT ?"), [cwd, HISTORY.PER_AGENT_LIMIT]]
      : [db.prepare("SELECT id, title, started_at FROM sessions WHERE title != '' ORDER BY started_at DESC LIMIT ?"), [HISTORY.PER_AGENT_LIMIT]];
    return stmt.all(...args).map((r) => ({
      sessionId: r.id,
      title: cleanTitle(r.title),
      cwd,
      updatedAt: (r.started_at || 0) * 1000
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function collectHermes(source, cwd, limit) {
  const rows = hermesDbRows(cwd);
  return byNewest(rows, source, cwd).slice(0, limit);
}

function collectAntigravity(source, cwd, limit) {
  const rows = antigravityRows(cwd);
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
      size: row.size ?? (row.filePath ? fileSizeBytes(row.filePath) : 0),
      resume: resumeCommand(source.id, row.sessionId),
      filePath: row.filePath
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function conversationTitle(agent, conversationId, cwd) {
  if (!agent || !conversationId || !cwd) return "";
  const cached = cache.get(cwd);
  if (!cached) return "";
  const row = cached.rows.find((r) => r.agent === agent && r.sessionId === conversationId);
  return row?.title || "";
}

const cache = new Map();

export function clearHistoryCache() {
  cache.clear();
}

// Sibling worktrees of a repo: if the cwd belongs to a repo with linked worktrees,
// the history includes sessions from the main checkout (unlabeled) plus each linked
// worktree (labeled with its branch). Both main and worktrees see the same list.
function repoWorktreeInfo(cwd) {
  if (!findGitRoot(cwd)) return null;
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd, timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    });
    const trees = parseWorktreeList(out);
    if (!trees || trees.length <= 1) return null;
    const main = trees[0];
    if (!main?.path) return null;
    const linked = trees.slice(1)
      .filter((w) => !w.bare && fs.existsSync(w.path))
      .map((w) => ({
        path: path.resolve(w.path),
        branch: (w.branch && w.branch !== "main" && w.branch !== "master") ? w.branch : path.basename(w.path)
      }));
    if (!linked.length) return null;
    return { mainPath: path.resolve(main.path), linked };
  } catch {
    return null;
  }
}

export async function listAgentSessions({ cwd, limit = HISTORY.DEFAULT_LIMIT, fresh = false } = {}) {
  if (!cwd) return [];
  const cached = cache.get(cwd);
  if (!fresh && cached && Date.now() - cached.at < HISTORY.CACHE_TTL_MS) return cached.rows.slice(0, limit);

  const rows = [];
  const wtInfo = repoWorktreeInfo(cwd);

  if (!wtInfo) {
    for (const source of HISTORY_SOURCES) {
      const collect = COLLECTORS[source.layout];
      rows.push(...collect(source, cwd, HISTORY.PER_AGENT_LIMIT));
    }
  } else {
    // Collect from main checkout (no branch label)
    for (const source of HISTORY_SOURCES) {
      const collect = COLLECTORS[source.layout];
      rows.push(...collect(source, wtInfo.mainPath, HISTORY.PER_AGENT_LIMIT));
    }
    // Collect from each linked worktree (labeled with its worktree branch)
    for (const wt of wtInfo.linked) {
      for (const source of HISTORY_SOURCES) {
        const collect = COLLECTORS[source.layout];
        rows.push(...collect(source, wt.path, HISTORY.PER_AGENT_LIMIT).map((r) => ({ ...r, branch: wt.branch })));
      }
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt || SOURCE_RANK.get(a.agent) - SOURCE_RANK.get(b.agent));

  const seen = new Set();
  const unique = rows.filter((row) => {
    const key = `${row.agent}:${row.sessionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  cache.set(cwd, { at: Date.now(), rows: unique });
  return unique.slice(0, limit);
}

// ---- Global conversation search --------------------------------------------
// Scans every source's transcripts across ALL cwds for a case-insensitive
// substring. Rows keep the list shape (no snippet): search exists to identify
// WHICH conversation — resume shows the rest.
// ponytail: sync single-thread scan bounded by the SEARCH_* budget; move to a
// worker thread if it ever stutters terminal streaming.

// Directory depth from each source root that reaches every cwd's transcripts.
const SEARCH_FILE_DEPTH = { cwdDir: 3, scan: HISTORY.SCAN_DEPTH, opencode: 0 };

const likeEscape = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

// SQLite-backed stores: message bodies live in shapes we don't parse, so the
// LIKE matches title (plus preview where one exists) only.
const SQLITE_SEARCH = {
  opencode: {
    db: () => path.join(home(), ".local", "share", "opencode", "opencode.db"),
    sql: "SELECT id AS sessionId, title, directory AS cwd, time_updated AS at FROM session " +
      "WHERE parent_id IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY time_updated DESC",
    args: (like) => [like],
    map: (r) => ({ ...r, updatedAt: r.at || 0 })
  },
  devin: {
    db: () => path.join(home(), ".local", "share", "devin", "cli", "sessions.db"),
    sql: "SELECT id AS sessionId, title, working_directory AS cwd, last_activity_at AS at FROM sessions " +
      "WHERE (hidden = 0 OR hidden IS NULL) AND title LIKE ? ESCAPE '\\' ORDER BY last_activity_at DESC",
    args: (like) => [like],
    map: (r) => ({ ...r, updatedAt: (r.at || 0) * 1000 })
  },
  hermes: {
    db: () => path.join(home(), ".hermes", "state.db"),
    sql: "SELECT id AS sessionId, title, started_at AS at FROM sessions " +
      "WHERE title != '' AND title LIKE ? ESCAPE '\\' ORDER BY started_at DESC",
    args: (like) => [like],
    map: (r) => ({ ...r, cwd: null, updatedAt: (r.at || 0) * 1000 })
  },
  antigravity: {
    db: () => path.join(home(), ".gemini", "antigravity-cli", "conversation_summaries.db"),
    sql: "SELECT conversation_id AS sessionId, title, preview, last_modified_time AS at, workspace_uris FROM conversation_summaries " +
      "WHERE title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' ORDER BY last_modified_time DESC",
    args: (like) => [like, like],
    map: (r) => {
      let cwd = null;
      if (r.workspace_uris) {
        try {
          const uris = JSON.parse(r.workspace_uris);
          const first = Array.isArray(uris) ? uris[0] : null;
          if (typeof first === "string") cwd = decodeURIComponent(first.replace(/^file:\/\//, ""));
        } catch {}
      }
      return { sessionId: r.sessionId, title: r.title || r.preview, cwd, updatedAt: Date.parse(r.at) || 0 };
    }
  }
};

const CWD_IN_TEXT_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

// One-line evidence of where the query matched. Skips the first occurrence
// when the title itself contains it — that hit is the title's own source line
// (boilerplate), the snippet must add context the row does not already show.
function buildSnippet(text, lower, firstIdx, q, skipFirst) {
  let idx = firstIdx;
  if (skipFirst) {
    const next = lower.indexOf(q, idx + q.length);
    if (next !== -1) idx = next;
  }
  let from = Math.max(0, idx - HISTORY.SEARCH_SNIPPET_PAD);
  let to = Math.min(text.length, idx + q.length + HISTORY.SEARCH_SNIPPET_PAD);
  // Raw JSONL windows leak syntax ("content":"…). The match lives inside some
  // JSON string — clamp the window to that string's enclosing quotes so the
  // snippet reads as prose. Best effort: escaped quotes just start mid-string.
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEnd = text.indexOf("\n", idx);
  const qStart = text.lastIndexOf('"', idx);
  const qEnd = text.indexOf('"', idx + q.length);
  if (qStart !== -1 && qEnd !== -1 && qStart >= lineStart && (lineEnd === -1 || qEnd <= lineEnd)) {
    from = Math.max(from, qStart + 1);
    to = Math.min(to, qEnd);
  }
  const clean = text.slice(from, to)
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const body = clean.length > HISTORY.SEARCH_SNIPPET_MAX ? `${clean.slice(0, HISTORY.SEARCH_SNIPPET_MAX - 1)}…` : clean;
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

export async function searchAgentSessions({ query, limit = HISTORY.SEARCH_LIMIT } = {}) {
  const q = String(query || "").trim().slice(0, HISTORY.SEARCH_QUERY_MAX).toLowerCase();
  if (q.length < HISTORY.SEARCH_MIN_CHARS) return { sessions: [], truncated: false };

  const start = Date.now();
  let bytes = 0;
  let truncated = false;
  const rows = [];
  const like = likeEscape(q);

  for (const source of HISTORY_SOURCES) {
    const conf = SQLITE_SEARCH[source.id];
    if (!conf) continue;
    const dbPath = conf.db();
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new (loadSqlite().DatabaseSync)(dbPath, { readOnly: true });
      for (const rec of db.prepare(conf.sql).all(...conf.args(like)).slice(0, limit * 2)) {
        const r = conf.map(rec);
        if (!r.sessionId) continue;
        rows.push({
          agent: source.id,
          sessionId: r.sessionId,
          title: cleanTitle(r.title || ""),
          cwd: r.cwd || null,
          updatedAt: r.updatedAt || 0,
          size: 0,
          resume: resumeCommand(source.id, r.sessionId)
        });
      }
    } catch {} finally {
      try { db?.close(); } catch {}
    }
  }

  const files = [];
  for (const source of HISTORY_SOURCES) {
    const depth = SEARCH_FILE_DEPTH[source.layout];
    if (depth === undefined) continue;
    for (const filePath of filesUnder(source.root(), depth, source.ext, source.file)) {
      files.push({ filePath, source, mtime: mtimeMs(filePath) });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { filePath, source } of files) {
    if (rows.length >= limit * 2) break;
    if (bytes > HISTORY.SEARCH_TOTAL_BYTES || Date.now() - start > HISTORY.SEARCH_TIME_BUDGET_MS) { truncated = true; break; }
    if (fileSizeBytes(filePath) > HISTORY.SEARCH_FILE_BYTES) continue;
    let text;
    try { text = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    bytes += text.length;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const parsed = source.parse(filePath);
    const title = cleanTitle(parsed?.title || "");
    const snippet = buildSnippet(text, lower, idx, q, normalizePrompt(title).includes(q));
    const sessionId = parsed?.sessionId || path.basename(filePath, path.extname(filePath));
    let cwd = parsed?.cwd || null;
    if (!cwd) {
      const m = text.match(CWD_IN_TEXT_RE);
      if (m) { try { cwd = JSON.parse(`"${m[1]}"`); } catch {} }
    }
    rows.push({
      agent: source.id,
      sessionId,
      title,
      snippet,
      cwd,
      updatedAt: mtimeMs(filePath),
      size: fileSizeBytes(filePath),
      resume: resumeCommand(source.id, sessionId),
      filePath
    });
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt || SOURCE_RANK.get(a.agent) - SOURCE_RANK.get(b.agent));
  const seen = new Set();
  const unique = rows.filter((row) => {
    const key = `${row.agent}:${row.sessionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { sessions: unique.slice(0, limit), truncated };
}

export async function deleteAgentSession({ agent, sessionId, cwd } = {}) {
  if (!agent || !sessionId) return false;
  const source = SOURCE_BY_ID.get(agent);
  if (!source) return false;

  let deleted = false;

  if (agent === "opencode") {
    const sqlite = loadSqlite();
    if (sqlite) {
      const dbPath = path.join(home(), ".local", "share", "opencode", "opencode.db");
      if (fs.existsSync(dbPath)) {
        let db;
        try {
          db = new sqlite.DatabaseSync(dbPath);
          db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
          deleted = true;
        } catch {} finally {
          try { db?.close(); } catch {}
        }
      }
    }
  }
  if (agent === "devin") {
    const sqlite = loadSqlite();
    if (sqlite) {
      const dbPath = path.join(home(), ".local", "share", "devin", "cli", "sessions.db");
      if (fs.existsSync(dbPath)) {
        let db;
        try {
          db = new sqlite.DatabaseSync(dbPath);
          db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
          deleted = true;
        } catch {} finally {
          try { db?.close(); } catch {}
        }
      }
    }
  }
  if (agent === "antigravity" && antigravityDelete(sessionId)) deleted = true;

  const cached = cwd ? cache.get(cwd) : null;
  const cachedRow = cached?.rows?.find((r) => r.agent === agent && r.sessionId === sessionId);
  let filePath = cachedRow?.filePath;

  const rootDir = source.root();
  if (!filePath) {
    if (source.layout === "cwdDir" && cwd && source.encode) {
      const base = path.join(rootDir, source.encode(cwd), source.sub || "");
      if (source.file) {
        filePath = path.join(base, sessionId, source.file);
      } else {
        filePath = path.join(base, `${sessionId}${source.ext}`);
      }
    } else if (source.layout === "opencode") {
      filePath = path.join(rootDir, `${sessionId}${source.ext}`);
    } else if (source.layout === "scan") {
      const direct = path.join(rootDir, `${sessionId}${source.ext}`);
      if (fs.existsSync(direct)) {
        filePath = direct;
      } else {
        const files = filesUnder(rootDir, HISTORY.SCAN_DEPTH, source.ext, source.file);
        for (const f of files) {
          if (source.parse(f)?.sessionId === sessionId) {
            filePath = f;
            break;
          }
        }
      }
    }
  }

  const isInside = (target, root) => target === root || target.startsWith(root + path.sep);
  if (filePath && fs.existsSync(filePath)) {
    const resolvedPath = path.resolve(filePath);
    const resolvedRoot = path.resolve(rootDir);
    if (isInside(resolvedPath, resolvedRoot)) {
      try {
        fs.rmSync(filePath, { force: true });
        deleted = true;
      } catch {}

      try {
        if (source.file) {
          const parentDir = path.dirname(filePath);
          if (parentDir !== resolvedRoot && isInside(parentDir, resolvedRoot)) {
            fs.rmSync(parentDir, { recursive: true, force: true });
          }
        } else {
          const companionDir = filePath.slice(0, -source.ext.length);
          if (fs.existsSync(companionDir) && isInside(companionDir, resolvedRoot)) {
            fs.rmSync(companionDir, { recursive: true, force: true });
          }
          const settingsFile = `${filePath.slice(0, -source.ext.length)}.settings${source.ext}`;
          if (fs.existsSync(settingsFile) && isInside(settingsFile, resolvedRoot)) {
            fs.rmSync(settingsFile, { force: true });
          }
        }
      } catch {}
    }
  }

  if (cwd && cache.has(cwd)) {
    const entry = cache.get(cwd);
    const before = entry.rows.length;
    entry.rows = entry.rows.filter((r) => !(r.agent === agent && r.sessionId === sessionId));
    if (entry.rows.length !== before) deleted = true;
  } else {
    cache.clear();
  }

  return deleted;
}
