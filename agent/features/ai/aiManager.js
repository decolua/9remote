// Manages all active AI sessions across Claude, Codex, and OpenCode
import fs from "node:fs";
import path from "node:path";
import { AI_ENGINES, ORPHAN_SWEEP_INTERVAL_MS, AI_IDLE_TICK_MS } from "./constants.js";
import { AiSession } from "./aiSession.js";
import * as daemonClient from "../terminal/ptyDaemonClient.js";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { registerDoneReleaser } from "../terminal/statusManager.js";

const logger = createLogger("ai");

export class AiManager {
  constructor() {
    this.sessions = new Map();
    this.eventListeners = new Set();
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // `seq` is the position this event has in the session's replay log. It has to reach the
  // client: without it the client's "already applied" gate never fires, so a replayed turn
  // and the live copy of it both land — the same prompt drawn twice.
  broadcastEvent(sessionId, event, data, seq) {
    for (const listener of this.eventListeners) {
      try {
        listener(sessionId, event, data, seq);
      } catch {}
    }
  }

  createSession(sessionId, engine, cwd, options = {}) {
    const validEngines = Object.values(AI_ENGINES);
    if (!validEngines.includes(engine)) {
      throw new Error(`Invalid AI engine: ${engine}. Supported: ${validEngines.join(", ")}`);
    }

    if (this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      if (existing.engine === engine && existing.cwd === cwd) {
        return existing;
      }
      existing.destroy();
      this.sessions.delete(sessionId);
    }

    const session = new AiSession({
      id: sessionId,
      engine,
      cwd,
      options,
      onEvent: (sId, event, data, seq) => this.broadcastEvent(sId, event, data, seq)
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Stop the session and drop it from the registry before any IPC. `destroy()` starts
   * an async adapter stop; leaving the session in the map while that is in flight lets
   * a create for the same id find it and hand back a dead session — and lets a
   * re-create race the stop, so the old process's exit tears down the new one.
   */
  destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.destroy();
    return true;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      engine: s.engine,
      cwd: s.cwd,
      createdAt: s.createdAt,
      lastPrompt: s.lastPrompt
    }));
  }
}

// Global instance for agent daemon
export const globalAiManager = new AiManager();

// Daemon-held CLI procs are keyed by chat id; a proc whose chat no longer exists (a
// stop RPC that never landed, a snapshot pruned while the agent was down) is RAM held
// forever — the daemon has no owner of its own. Owner = a live session or a snapshot
// file on disk; anything else in the daemon's proc map is an orphan.
function chatExists(procId) {
  if (globalAiManager.sessions.has(procId)) return true;
  // Same sanitize as aiSnapshotFile(): id -> `<engine>-<safe>.json`.
  const safe = String(procId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return Object.values(AI_ENGINES).some((engine) =>
    fs.existsSync(path.join(PATHS.AI_SESSIONS, `${engine}-${safe}.json`)));
}

export async function sweepOrphanProcs(client = daemonClient) {
  if (!client.isConnected()) return;
  try {
    const held = await client.procList();
    const procs = Array.isArray(held) ? held : held?.procs || [];
    for (const proc of procs) {
      const id = proc?.procId || proc?.id;
      if (!id || chatExists(id)) continue;
      // Re-check at kill time: a chat created after the list was fetched is in the map
      // before its first proc RPC can land.
      await new Promise((resolve) => setImmediate(resolve));
      if (chatExists(id)) continue;
      await client.procStop(id);
      logger.info(`[proc-sweep] stopped orphan daemon proc ${id} (${proc.total || 0} lines buffered)`);
    }
  } catch {
    // The daemon is optional; the next tick retries.
  }
}

let sweepTimer = null;
// Boot: sweep once the daemon connects (or now, if it already has). Runtime: the
// interval catches leaks born mid-flight (e.g. a procStop refused while the daemon
// socket was reconnecting).
function scheduleOrphanSweep() {
  const start = () => {
    if (sweepTimer) return sweepOrphanProcs();
    sweepTimer = setInterval(sweepOrphanProcs, ORPHAN_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    sweepOrphanProcs();
  };
  if (daemonClient.isConnected()) start();
  else daemonClient.on("connected", start);
}
scheduleOrphanSweep();

// Idle-kill ticker: one door for every session — no per-session timers to leak,
// and the eligibility check re-reads live state on every tick.
setInterval(() => {
  for (const s of globalAiManager.sessions.values()) s.idleKill?.();
}, AI_IDLE_TICK_MS).unref?.();

// A hook-reported DONE outranks a turn whose `result` line the stream lost — end it
// so clients stop spinning and sendPrompt unblocks. No-op when the turn already ended.
registerDoneReleaser((sessionId) => {
  const session = globalAiManager.getSession(sessionId);
  if (!session?.isTurnRunning) return;
  session.emitNormalized("turn_complete", { stats: null, result: "", isError: false, subtype: "" });
});
