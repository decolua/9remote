// Manages long-lived OpenCode HTTP server process for rewind and file snapshot APIs.
import { spawn } from "node:child_process";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("ai");
const BOOT_TIMEOUT_MS = 15000;
const PORT_POLL_MS = 250;

const v2Sessions = new Set();

let proc = null;
let base = null;
let booting = null;

async function waitForPort(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
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
  return 41998;
}

async function api(method, path, body) {
  const url = await ensureServer();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const msg = parsed?.message || parsed?.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed?.data !== undefined ? parsed.data : parsed;
}

export async function createSession(cwd) {
  const s = await api("POST", "/api/session", { location: { directory: cwd } });
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

export async function interruptSession(sessionId) {
  const url = await ensureServer();
  const res = await fetch(`${url}/api/session/${sessionId}/interrupt`, { method: "POST", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`interrupt failed: HTTP ${res.status}`);
}

// Subscribe to global v2 event bus (GET /api/event SSE); caller filters by sessionID.
export function subscribeBus(onEvent) {
  let closed = false;
  let currentReader = null;
  (async function loop() {
    while (!closed) {
      try {
        const url = await ensureServer();
        const res = await fetch(`${url}/api/event`, { headers: { accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
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

export function stopServer() {
  try { proc?.kill(); } catch {}
  proc = null;
  base = null;
}
