// Centralized logger — single sink for console + crash + remote + tunnel
// Routes every message to: file (rotate 2MB x 2) + stdout + SSE (TUI/Web UI).
import fs from "fs";
import path from "path";
import { LOG_CONFIG, PATHS } from "./constants.js";

const LOG_DIR = PATHS.LOGS;
const LOG_FILE = path.join(LOG_DIR, LOG_CONFIG.fileName);
const ROTATED_FILE = path.join(LOG_DIR, LOG_CONFIG.rotatedName);

let initialized = false;
let sseEmitter = null;
const origConsole = { log: console.log, warn: console.warn, error: console.error };

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Rotate when size exceeds threshold: rename current → .1 (overwrite previous)
function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < LOG_CONFIG.maxBytes) return;
    try { fs.rmSync(ROTATED_FILE, { force: true }); } catch {}
    fs.renameSync(LOG_FILE, ROTATED_FILE);
  } catch {}
}

// Drop rotated file if older than threshold (runs once at init)
function cleanupOldFiles() {
  try {
    const st = fs.statSync(ROTATED_FILE);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > LOG_CONFIG.cleanupAfterDays * 86400000) fs.rmSync(ROTATED_FILE, { force: true });
  } catch {}
}

function writeLine(line) {
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// Format args like console.log does
function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(" ");
}

// Compact timestamp: HH:mm:ss.SSS — short, easy to read in tail
function shortTs() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Strip URLs from any log line — sensitive tunnel hostnames must never leak
const URL_REGEX = /https?:\/\/[^\s]+/g;
function stripUrl(s) { return String(s).replace(URL_REGEX, "").replace(/\s+$/g, "").replace(/[:\s-]+$/, ""); }

function emit(level, msg) {
  const clean = stripUrl(msg);
  writeLine(`${shortTs()} [${level}] ${clean}`);
  if (sseEmitter) { try { sseEmitter(clean); } catch {} }
}

// Patch console.* — preserve stdout behavior, also tee to file + SSE
function patchConsole() {
  console.log = (...args) => { const m = fmt(args); origConsole.log(...args); emit("info", m); };
  console.warn = (...args) => { const m = fmt(args); origConsole.warn(...args); emit("warn", m); };
  console.error = (...args) => { const m = fmt(args); origConsole.error(...args); emit("error", m); };
}

function setupCrashHandlers() {
  process.on("uncaughtException", (err) => {
    emit("crash", `uncaughtException: ${err?.stack || err?.message || err}`);
  });
  process.on("unhandledRejection", (reason) => {
    const r = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    emit("crash", `unhandledRejection: ${r}`);
  });
  process.on("exit", (code) => {
    writeLine(`${shortTs()} [exit] code=${code} pid=${process.pid}`);
  });
}

export function initLogger() {
  if (initialized) return;
  initialized = true;
  ensureDir();
  cleanupOldFiles();
  writeLine(`\n=== SESSION ${new Date().toISOString()} pid=${process.pid} argv=${process.argv.slice(2).join(" ")} ===`);
  patchConsole();
  setupCrashHandlers();
}

// Server side registers SSE forwarder so logs reach TUI/Web UI live
export function setSseEmitter(fn) { sseEmitter = fn; }

// Read last N lines from log file for "View Logs" history (TUI + Web UI)
export function readRecentLogs(lines = 60) {
  try {
    const buf = fs.readFileSync(LOG_FILE, "utf8");
    const arr = buf.split("\n").filter(Boolean);
    return arr.slice(-lines);
  } catch { return []; }
}

// Direct log channel (for modules that want a custom level tag)
export function log(level, ...args) { emit(level, fmt(args)); }

export const LOG_FILE_PATH = LOG_FILE;
export const ROTATED_FILE_PATH = ROTATED_FILE;
