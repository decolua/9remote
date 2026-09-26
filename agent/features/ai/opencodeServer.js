// Manages long-lived OpenCode HTTP server process for rewind and file snapshot APIs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "../../lib/logger.js";
import { OPENCODE_SERVER_PORT, OPENCODE_PROMPT_TIMEOUT_MS } from "./constants.js";
import { getExtendedEnv } from "./adapters/env.js";

const logger = createLogger("ai");
const BOOT_TIMEOUT_MS = 15000;
const PORT_POLL_MS = 250;
// The command route blocks until the whole agent loop ends — the generic 30s
// api timeout would abort live command turns mid-stream.
const COMMAND_TIMEOUT_MS = 600000;

const v2Sessions = new Set();

let proc = null;
let base = null;
let booting = null;
// PID of an adopted server a previous 9remote agent spawned (marker file match):
// retirable when idle, unlike one the user started by hand.
let adoptedOurs = null;

const markerFile = () => path.join(os.tmpdir(), `9remote-opencode-serve-${OPENCODE_SERVER_PORT}.pid`);
const clearMarker = () => { try { fs.unlinkSync(markerFile()); } catch {} };
const markerMatches = async (pid) => {
  if (!pid) return false;
  try { return String(fs.readFileSync(markerFile(), "utf8")).trim() === String(pid); } catch { return false; }
};

function opencodeDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode");
}

function readOpencodeAuth() {
  try {
    const authPath = path.join(opencodeDataDir(), "auth.json");
    if (!fs.existsSync(authPath)) return null;
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}

function buildOpencodeEnv() {
  const env = getExtendedEnv();
  const auth = readOpencodeAuth();
  if (auth && typeof auth === "object") {
    if (auth["opencode-go"]?.key && !env.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = auth["opencode-go"].key;
    }
  }
  return env;
}

// Sync API keys from auth.json to v2 server integrations so models become available.
async function syncCredentials(url) {
  const auth = readOpencodeAuth();
  if (!auth || typeof auth !== "object") return;
  for (const [id, entry] of Object.entries(auth)) {
    if (entry?.type === "api" && entry.key) {
      try {
        await fetch(`${url}/api/integration/${id}/connect/key`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: entry.key }),
          signal: AbortSignal.timeout(3000)
        });
      } catch (e) {
        logger.warn(`[opencode] failed to sync credential for ${id}: ${e.message}`);
      }
    }
  }
}

async function waitForPort(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
      // Another HTTP process on the port answers HTML — not our server.
      if (res.ok && (res.headers.get("content-type") || "").includes("application/json")) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, PORT_POLL_MS));
  }
  return false;
}

// Find PID listening on port via lsof (macOS/Linux).
async function portHolder(port) {
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise((resolve) =>
      execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeout: 3000 }, (e, stdout) => resolve(e ? "" : stdout)));
    return out.split("\n").map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

// Verify PID is an opencode serve process before terminating.
async function isOurServer(pid) {
  try {
    const { execFile } = await import("node:child_process");
    const cmd = await new Promise((resolve) =>
      execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 }, (e, stdout) => resolve(e ? "" : stdout)));
    return /opencode\s+serve/.test(cmd);
  } catch {
    return false;
  }
}

// Ensure OpenCode server is running and return its base URL.
export async function ensureServer() {
  if (base && proc && proc.exitCode === null) return base;
  if (booting) return booting;

  booting = (async () => {
    const port = serverPort();
    const url = `http://127.0.0.1:${port}`;

    // Adopt running server if already answering on port.
    if (await waitForPort(url, Date.now() + 1000)) {
      base = url;
      // A leftover from an earlier 9remote agent is still ours to retire.
      const holder = await portHolder(port);
      if (await markerMatches(holder)) {
        adoptedOurs = Number(holder);
        // No session retained it in THIS run — without arming here an adopted
        // leftover outlives the agent forever (nobody opens a chat to release it).
        armIdleStop();
      }
      syncCredentials(url).catch(() => {});
      return url;
    }

    // Terminate unresponsive OpenCode server holding the port.
    for (let attempt = 0; attempt < 2; attempt++) {
      proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        env: buildOpencodeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      proc.stdout.on("data", () => {});
      // Drain stderr to prevent pipe buffer from filling.
      proc.stderr.on("data", () => {});
      proc.on("error", (e) => {
        logger.warn(`[opencode] server failed to start: ${e.message}`);
        proc = null;
        base = null;
      });
      proc.on("exit", () => {
        proc = null;
        base = null;
        clearMarker();
      });

      if (await waitForPort(url, Date.now() + BOOT_TIMEOUT_MS)) {
        base = url;
        // Ownership marker: a later agent adopts this server knowing it is ours.
        try { fs.writeFileSync(markerFile(), String(proc.pid)); } catch {}
        // A caller with no chat session (e.g. the model catalog) must not leave
        // the spawn alive forever; armIdleStop no-ops when a session retained it.
        armIdleStop();
        syncCredentials(url).catch(() => {});
        return url;
      }
      try { proc?.kill(); } catch {}
      proc = null;

      const holder = await portHolder(port);
      if (!holder || !(await isOurServer(holder))) break;
      logger.warn(`[opencode] unresponsive server pid ${holder} holds port ${port} — replacing it`);
      try { process.kill(Number(holder), "SIGTERM"); } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    booting = null;
    throw new Error("opencode server did not start");
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

function serverPort() {
  return OPENCODE_SERVER_PORT;
}

// How long the server outlives its last chat session: long enough that closing
// one pane and opening another does not pay the boot again, short enough that a
// deleted session does not leave an `opencode serve` process running for good.
const SERVER_IDLE_STOP_MS = 30000;
let sessionCount = 0;
let idleStopTimer = null;
// Test-only override for SERVER_IDLE_STOP_MS so retire paths run in milliseconds.
let testIdleMs = null;

/** Arm the idle retirement if no chat session holds the server. */
function armIdleStop() {
  if (sessionCount > 0 || idleStopTimer) return;
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    if (sessionCount > 0) return;
    // Only servers WE spawned (now, or in an earlier agent run): one the user
    // started by hand carries no marker and is not ours to stop.
    // The ids belong to the retiring server; a fresh one repopulates on create.
    v2Sessions.clear();
    if (proc) { try { proc.kill("SIGTERM"); } catch {} return; }
    if (adoptedOurs) {
      try { process.kill(adoptedOurs, "SIGTERM"); } catch {}
      clearMarker();
    }
  }, testIdleMs ?? SERVER_IDLE_STOP_MS);
  idleStopTimer.unref?.();
}

/** A chat session started using the server — keeps it alive past idle stops. */
export function retainForSession() {
  sessionCount += 1;
  if (idleStopTimer) { clearTimeout(idleStopTimer); idleStopTimer = null; }
}

/** A chat session went away — the LAST one retires the server we spawned. */
export function releaseForSession() {
  sessionCount = Math.max(0, sessionCount - 1);
  armIdleStop();
}

async function api(method, path, body, { timeoutMs = 30000 } = {}) {
  const url = await ensureServer();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  // Unmatched /api/* paths answer 200 with the web UI's HTML — never data.
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(`opencode ${path} unavailable (HTML answer — route missing on this server)`);
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed?.data !== undefined ? parsed.data : parsed;
}

export async function createSession(cwd, extras = {}) {
  const s = await api("POST", "/api/session", { location: { directory: cwd }, ...extras });
  if (s?.id) v2Sessions.add(s.id);
  return s;
}

export const isV2Session = (id) => v2Sessions.has(id);

// v1 route: the v2 mirror answers an empty list even for sessions it holds.
export const listMessages = (sessionId) => api("GET", `/session/${sessionId}/message`);

// Session info including the agent it currently runs (read before a mode PATCH).
export const getSession = (sessionId) => api("GET", `/api/session/${sessionId}`);

// The same PATCH the TUI's rename dialog sends; the server emits session.updated.
export const renameSession = (sessionId, title) => api("PATCH", `/api/session/${sessionId}`, { title });

export const activeSessions = () => api("GET", "/api/session/active");

// v1 message route, NOT /api/.../prompt: on 1.18.x the v2 endpoint only steers a
// running turn — an idle session admits the prompt (200 OK) but never runs it,
// and even a resumed turn persists nothing to the store. ponytail: if v1 goes
// away, its replacement must both start the turn and persist messages.
// The call resolves when the whole agent loop ends, so it needs the long
// command timeout, not the generic 30s api one.
export const prompt = (sessionId, body) =>
  api("POST", `/session/${sessionId}/message`, typeof body === "string" ? { parts: [{ type: "text", text: body }] } : body, { timeoutMs: OPENCODE_PROMPT_TIMEOUT_MS });

export const setSessionModel = (sessionId, model) =>
  api("POST", `/api/session/${sessionId}/model`, { model });

// v1 routes on the same serve process: the command menu (GET /command) and
// command execution (POST /session/:id/command) — /api/command is bare on 1.18.x.
const COMMAND_WARMUP_RETRY_MS = 400;

export async function listCommands() {
  let list = await api("GET", "/command");
  // First call after boot can answer [] while commands load — retry once.
  if (!Array.isArray(list) || list.length === 0) {
    await new Promise((r) => setTimeout(r, COMMAND_WARMUP_RETRY_MS));
    list = await api("GET", "/command");
  }
  return Array.isArray(list) ? list : [];
}

export const runCommand = (sessionId, body) =>
  api("POST", `/session/${sessionId}/command`, body, { timeoutMs: COMMAND_TIMEOUT_MS });

// Mode = agent on the v2 server (build = full access, plan = read-only).
export const setSessionAgent = (sessionId, agent) =>
  api("POST", `/api/session/${sessionId}/agent`, { agent });

// v2 gates: permission/question requests and their replies.
export const requestPermission = (sessionId, body) =>
  api("POST", `/api/session/${sessionId}/permission`, body);

export const pendingPermissions = (sessionId) =>
  api("GET", `/api/session/${sessionId}/permission`);

export const replyPermission = (sessionId, requestId, reply, message = "") =>
  api("POST", `/api/session/${sessionId}/permission/${requestId}/reply`, { reply, ...(message ? { message } : {}) });

// The question tool's gates live in the v1 store behind /question — the
// /api/session mirror answers an empty list even for sessions it holds. That store is
// instance state scoped by directory: without the param the server reads the serve
// process's own cwd, a different store than the session's directory.
const scopedQuestion = (path, directory) =>
  directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;

// Pending gates, all sessions in the directory; each entry carries the que_ id
// its reply route wants and the sessionID it blocks.
export const listPendingQuestions = (directory) =>
  api("GET", scopedQuestion("/question", directory));

export const replyQuestion = (requestId, answers, directory) =>
  api("POST", scopedQuestion(`/question/${requestId}/reply`, directory), { answers });

export const rejectQuestion = (requestId, directory) =>
  api("POST", scopedQuestion(`/question/${requestId}/reject`, directory));

export async function interruptSession(sessionId) {
  const url = await ensureServer();
  const res = await fetch(`${url}/api/session/${sessionId}/interrupt`, { method: "POST", signal: AbortSignal.timeout(10000) });
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(`opencode interrupt unavailable (HTML answer — route missing on this server)`);
  }
  if (!res.ok) throw new Error(`interrupt failed: HTTP ${res.status}`);
}

// Subscribe to global v2 event bus (GET /api/event SSE); caller filters by sessionID.
// onReconnect fires after every successful (re)connection so the caller can
// reconcile state the gap may have missed — the stream itself has no replay.
export function subscribeBus(onEvent, { onReconnect = null } = {}) {
  let closed = false;
  // Aborts the in-flight connect too: close() during the fetch await leaks a
  // live SSE connection nothing will ever read.
  const abort = new AbortController();
  (async function loop() {
    while (!closed) {
      try {
        const url = await ensureServer();
        const res = await fetch(`${url}/api/event`, { headers: { accept: "text/event-stream" }, signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        if (onReconnect) { try { onReconnect(); } catch {} }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at;
          while ((at = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const data = frame.split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("");
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch {}
          }
        }
      } catch {
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return {
    close() {
      // No reader.cancel() here: on an aborted body it rejects with the abort's
      // own AbortError, and nothing is left to catch it (the unhandled
      // rejection on every surface switch). The signal tears the stream down.
      closed = true;
      try { abort.abort(); } catch {}
    }
  };
}

// Stage rewind to messageId and preview file changes without committing.
export const stageRevert = (sessionId, messageId, { files = true } = {}) =>
  api("POST", `/api/session/${sessionId}/revert/stage`, { messageID: messageId, files });

export const clearRevert = (sessionId) => api("POST", `/api/session/${sessionId}/revert/clear`);

export const commitRevert = (sessionId) => api("POST", `/api/session/${sessionId}/revert/commit`);

export const deleteSession = (sessionId) =>
  api("DELETE", `/api/session/${sessionId}`).finally(() => v2Sessions.delete(sessionId));

// Test hook: point api() at a fake server instead of spawning opencode.
export function _useTestBase(url) {
  base = url;
  // ensureServer short-circuits on a live proc; fake one while overridden.
  proc = url ? { exitCode: null } : null;
  booting = null;
}

// Test hook: swap in a fake server proc and/or adopted pid (to observe retire
// kills without spawning opencode) and shorten the idle window.
export function _useTestProc({ fake = null, adoptedPid = null, idleMs = null } = {}) {
  testIdleMs = idleMs;
  base = fake || adoptedPid ? "http://test" : null;
  proc = fake;
  adoptedOurs = adoptedPid;
  booting = null;
}

export function stopServer() {
  try { proc?.kill(); } catch {}
  proc = null;
  base = null;
}
