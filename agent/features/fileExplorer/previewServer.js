// Static HTML preview — serves the HTML file's own directory over the agent HTTP
// server so relative assets (css/js/img) resolve like a real website. Same trust
// model as agent/proxy: an unguessable session id in the path is the only auth
// (iframe subresources cannot carry headers), and sessions expire on their own.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { MIME_BY_EXT, PREVIEW_SESSION_TTL_MS, MAX_PREVIEW_SESSIONS } from "./constants.js";
import { isSensitivePath } from "./pathGuard.js";

// id → { root, realRoot, entry, expiresAt, timer }
const sessions = new Map();

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
}

function touch(s) {
  clearTimeout(s.timer);
  s.expiresAt = Date.now() + PREVIEW_SESSION_TTL_MS;
  s.timer = setTimeout(() => dropSession(s.id), PREVIEW_SESSION_TTL_MS);
}

// Mint a session for the directory holding filePath. Called over the authenticated
// socket, so this is the trust boundary — sensitive paths are rejected here.
export function startPreviewSession(filePath) {
  try {
    if (!filePath || typeof filePath !== "string") return { success: false, error: "File path required" };
    if (isSensitivePath(filePath)) return { success: false, error: "Access denied" };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { success: false, error: "Not a file" };

    const root = path.dirname(fs.realpathSync(filePath));
    // Evict the oldest session when the cap is hit rather than refusing the preview.
    while (sessions.size >= MAX_PREVIEW_SESSIONS) {
      const oldest = sessions.keys().next().value;
      dropSession(oldest);
    }

    const id = randomUUID();
    const s = { id, realRoot: root, entry: path.basename(filePath), expiresAt: 0, timer: null };
    sessions.set(id, s);
    touch(s);
    return { success: true, sessionId: id, entry: s.entry };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export function endPreviewSession(sessionId) {
  if (sessionId) dropSession(sessionId);
}

function endText(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

function contentTypeFor(filePath) {
  const ext = filePath.toLowerCase().split(".").pop();
  const mime = MIME_BY_EXT[ext] || "application/octet-stream";
  // Text types need an explicit charset or the browser sniffs latin-1.
  return /^(text\/|application\/(javascript|json))/.test(mime) ? `${mime}; charset=utf-8` : mime;
}

// Resolve a request path inside the session root; null when it escapes or misses.
// The router hands us the still-percent-encoded pathname, so decode first.
function resolveInside(s, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  const abs = path.resolve(s.realRoot, "." + decoded.replace(/\\/g, "/"));
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return null;
  }
  // realpath also collapses symlinks — anything pointing outside the root stops here.
  if (real !== s.realRoot && !real.startsWith(s.realRoot + path.sep)) return null;
  // The root is only checked when the session is minted; a root near $HOME would
  // otherwise expose ~/.ssh and friends to every subsequent asset request.
  if (isSensitivePath(real)) return null;
  return fs.statSync(real).isFile() ? real : null;
}

// Route handler for /preview/:sessionId/* — registered public in agent/index.js.
export function handlePreviewRequest(req, res, { pathname }) {
  const match = pathname.match(/^\/preview\/([0-9a-f-]+)(\/.*)?$/);
  const s = match ? sessions.get(match[1]) : null;
  if (!s) { endText(res, 404, "Preview session not found"); return; }

  const filePath = resolveInside(s, match[2] || "/" + s.entry);
  if (!filePath) { endText(res, 404, "Not found"); return; }

  // Every hit keeps the session alive; the timer is the only cleanup path.
  touch(s);

  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": fs.statSync(filePath).size,
    // Saved edits must show on reload — never let the browser cache a stale asset.
    "Cache-Control": "no-store",
    // The sandboxed iframe runs from a null origin — let page-side fetch() read too.
    "Access-Control-Allow-Origin": "*"
  });
  fs.createReadStream(filePath)
    // Headers are already sent — a mid-stream failure can only tear down the socket.
    .on("error", () => res.destroy())
    .pipe(res);
}

export function setupPreviewHandlers(socket) {
  socket.on("preview:start", ({ filePath }, callback) => {
    callback?.(startPreviewSession(filePath));
  });
  socket.on("preview:end", ({ sessionId }, callback) => {
    endPreviewSession(sessionId);
    callback?.({ success: true });
  });
}
