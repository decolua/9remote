// The opencode server: one long-lived process, spoken to over HTTP.
//
// Two reasons this exists rather than shelling out per call:
//
//  - Rewind needs the server API. `opencode run` creates sessions the server's v2
//    store cannot see (verified: the session resolves, its messages come back empty),
//    so the agent reads the conversation from the CLI's own SQLite — that is the only
//    source of truth both sides agree on.
//  - The engine's own file snapshot/restore lives behind that API, and it needs to be
//    the same process that saw the session.

import { spawn } from "node:child_process";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("ai");
const BOOT_TIMEOUT_MS = 15000;
const PORT_POLL_MS = 250;

// Sessions created by this server's own v2 store.
const v2Sessions = new Set();

let proc = null;
let base = null;
let booting = null;

async function waitForPort(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, PORT_POLL_MS));
  }
  return false;
}

/**
 * The process LISTENing on a port, if lsof can say (macOS/Linux; a Windows host
 * answers nothing and the caller gives up the usual way).
 */
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

/** Is this pid an `opencode serve` of our own port? Never kill anything else. */
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

/**
 * Start the server if it is not running, and return its base URL.
 * Concurrent callers share one boot — two servers on the same data dir fight.
 */
export async function ensureServer() {
  if (base && proc && proc.exitCode === null) return base;
  if (booting) return booting;

  booting = (async () => {
    // A fixed port: the CLI's own server has no discovery file, and 0 would hide which
    // one we are talking to. A second 9Remote instance reuses the running server.
    const port = serverPort();
    const url = `http://127.0.0.1:${port}`;

    // A server that already answers is adopted — it may be ours from an earlier
    // agent life, or another 9Remote instance's; both serve the same store.
    if (await waitForPort(url, Date.now() + 1000)) {
      base = url;
      return url;
    }

    // A wedged server from an earlier life can hold the port without answering
    // (measured: a 3-day-old one, every later chat dead with "did not start").
    // A healthy one is adopted; one of ours that stopped answering is replaced.
    for (let attempt = 0; attempt < 2; attempt++) {
      proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      proc.stdout.on("data", () => {});
      // The server's log is noisy and never actionable here; drain it or the pipe fills.
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
  // Not 41999: that was the spike's. Kept in one place so a change is one edit.
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

/** A session created through this server. The v2 store is the only one it can see. */
export async function createSession(cwd) {
  const s = await api("POST", "/api/session", { location: { directory: cwd } });
  if (s?.id) v2Sessions.add(s.id);
  return s;
}

export const isV2Session = (id) => v2Sessions.has(id);

export const listMessages = (sessionId) => api("GET", `/api/session/${sessionId}/message`);

/** Which sessions the server is still running — {sessionID: {type: "running"}}. */
export const activeSessions = () => api("GET", "/api/session/active");

// A string body keeps the old call shape (the rewind e2e and early probes); the
// chat passes the whole body — {prompt: {text, files?}} per the v2 protocol.
export const prompt = (sessionId, body) =>
  api("POST", `/api/session/${sessionId}/prompt`, typeof body === "string" ? { prompt: { text: body } } : body);

/** Point the session at a model (and variant) — the v2 way, POST /session/:id/model. */
export const setSessionModel = (sessionId, model) =>
  api("POST", `/api/session/${sessionId}/model`, { model });

/** Stop the running turn without killing the conversation — POST /session/:id/interrupt (204). */
export async function interruptSession(sessionId) {
  const url = await ensureServer();
  const res = await fetch(`${url}/api/session/${sessionId}/interrupt`, { method: "POST", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`interrupt failed: HTTP ${res.status}`);
}

/**
 * Subscribe to the v2 event bus (GET /api/event, SSE). Every envelope on the
 * machine flows here — the bus has no per-session scoping — so the caller filters
 * by `data.sessionID`. Reconnects with a pause; returns a close() that stops for
 * good. One subscription per chat pane is the intended use.
 */
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
            try { onEvent(JSON.parse(data)); } catch { /* a partial frame is not an event */ }
          }
        }
      } catch {
        // the server went away or the socket dropped — retry below
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

/**
 * Stage a rewind to `messageId`, restoring the files that turn changed.
 *
 * Staging is reversible — the server records where to put things back and touches
 * nothing until commit — so it doubles as the preview the confirm dialog needs: the
 * response lists exactly which files the commit would overwrite.
 */
export const stageRevert = (sessionId, messageId, { files = true } = {}) =>
  api("POST", `/api/session/${sessionId}/revert/stage`, { messageID: messageId, files });

/** Drop a staged rewind, leaving files and conversation as they were. */
export const clearRevert = (sessionId) => api("POST", `/api/session/${sessionId}/revert/clear`);

/** Apply a staged rewind for good. */
export const commitRevert = (sessionId) => api("POST", `/api/session/${sessionId}/revert/commit`);

export const deleteSession = (sessionId) =>
  api("DELETE", `/api/session/${sessionId}`).finally(() => v2Sessions.delete(sessionId));

export function stopServer() {
  try { proc?.kill(); } catch {}
  proc = null;
  base = null;
}
