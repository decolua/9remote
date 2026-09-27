// Centralized logger — file + SSE only. Console is reserved for TUI rendering.
import fs from "fs";
import path from "path";
import { LOG_CONFIG, PATHS } from "./constants.js";

const LOG_DIR = PATHS.LOGS;
const LOG_FILE = path.join(LOG_DIR, LOG_CONFIG.fileName);
const ROTATED_FILE = path.join(LOG_DIR, LOG_CONFIG.rotatedName);

let initialized = false;
let sseEmitter = null;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < LOG_CONFIG.maxBytes) return;
    try { fs.rmSync(ROTATED_FILE, { force: true }); } catch {}
    fs.renameSync(LOG_FILE, ROTATED_FILE);
  } catch {}
}

function cleanupOldFiles() {
  try {
    const st = fs.statSync(ROTATED_FILE);
    if (Date.now() - st.mtimeMs > LOG_CONFIG.cleanupAfterDays * 86400000) fs.rmSync(ROTATED_FILE, { force: true });
  } catch {}
}

function writeLine(line) {
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(" ");
}

function shortTs() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const URL_REGEX = /https?:\/\/[^\s]+/g;
function sanitize(s) {
  return String(s).replace(ANSI_REGEX, "").replace(URL_REGEX, "").replace(/\s+$/g, "");
}

// Tag format: [domain] for info, [domain:level] for warn/error/crash
function emit(domain, level, msg) {
  const clean = sanitize(msg);
  if (!clean) return;
  const tag = level === "info" ? domain : `${domain}:${level}`;
  const line = `${shortTs()} [${tag}] ${clean}`;
  writeLine(line);
  if (sseEmitter) { try { sseEmitter(line); } catch {} }
}

function setupCrashHandlers() {
  process.on("uncaughtException", (err) => emit("crash", "error", `uncaughtException: ${err?.stack || err?.message || err}`));
  process.on("unhandledRejection", (reason) => {
    const r = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    emit("crash", "error", `unhandledRejection: ${r}`);
  });
  process.on("exit", (code) => writeLine(`${shortTs()} [exit] code=${code} pid=${process.pid}`));
}

export function initLogger() {
  if (initialized) return;
  initialized = true;
  ensureDir();
  cleanupOldFiles();
  writeLine(`\n=== SESSION ${new Date().toISOString()} pid=${process.pid} argv=${process.argv.slice(2).join(" ")} ===`);
  setupCrashHandlers();
}

export function setSseEmitter(fn) { sseEmitter = fn; }

export function readRecentLogs(lines = 60) {
  try {
    const buf = fs.readFileSync(LOG_FILE, "utf8");
    const arr = buf.split("\n").filter(Boolean);
    return arr.slice(-lines);
  } catch { return []; }
}

export function clearRecentLogs() {
  try { fs.writeFileSync(LOG_FILE, ""); } catch {}
}

// Verbose transport/lifecycle logs (broadcast routing, daemon output, RTC timing)
// auto-enable in dev (NODE_ENV=development, set by the host:dev scripts) and stay
// quiet in production builds. warn/error always log. AGENT_DEBUG=1 opts back in.
export const IS_DEBUG = process.env.NODE_ENV === "development" || process.env.AGENT_DEBUG === "1";

export function createLogger(domain) {
  return {
    debug: (...args) => { if (IS_DEBUG) emit(domain, "debug", fmt(args)); },
    info: (...args) => emit(domain, "info", fmt(args)),
    warn: (...args) => emit(domain, "warn", fmt(args)),
    error: (...args) => emit(domain, "error", fmt(args)),
  };
}

export const LOG_FILE_PATH = LOG_FILE;
export const ROTATED_FILE_PATH = ROTATED_FILE;
