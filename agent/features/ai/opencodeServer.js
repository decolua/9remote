// Manages long-lived OpenCode HTTP server process for rewind and file snapshot APIs.
import { spawn } from "node:child_process";
import { createLogger } from "../../lib/logger.js";
import { OPENCODE_SERVER_PORT } from "./constants.js";

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
      return url;
    }

    // Terminate unresponsive OpenCode server holding the port.
    for (let attempt = 0; attempt < 2; attempt++) {
      proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
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
      });

      if (await waitForPort(url, Date.now() + BOOT_TIMEOUT_MS)) {
        base = url;
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

export const listMessages = (sessionId) => api("GET", `/api/session/${sessionId}/message`);

export const activeSessions = () => api("GET", "/api/session/active");

export const prompt = (sessionId, body) =>
  api("POST", `/api/session/${sessionId}/prompt`, typeof body === "string" ? { prompt: { text: body } } : body);

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

export const pendingQuestions = (sessionId) =>
  api("GET", `/api/session/${sessionId}/question`);

export const replyQuestion = (sessionId, requestId, answers) =>
  api("POST", `/api/session/${sessionId}/question/${requestId}/reply`, { answers });

export const rejectQuestion = (sessionId, requestId) =>
  api("POST", `/api/session/${sessionId}/question/${requestId}/reject`);

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
  let currentReader = null;
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
        currentReader = reader;
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
      } finally {
        currentReader = null;
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return {
    close() {
      closed = true;
      try { abort.abort(); } catch {}
      try { currentReader?.cancel(); } catch {}
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

export function stopServer() {
  try { proc?.kill(); } catch {}
  proc = null;
  base = null;
}
