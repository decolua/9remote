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

    const url = `http://127.0.0.1:${port}`;
    const up = await waitForPort(url, Date.now() + BOOT_TIMEOUT_MS);
    if (!up) {
      try { proc?.kill(); } catch {}
      proc = null;
      booting = null;
      throw new Error("opencode server did not start");
    }
    base = url;
    return url;
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

export const prompt = (sessionId, text) =>
  api("POST", `/api/session/${sessionId}/prompt`, { prompt: { text } });

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
