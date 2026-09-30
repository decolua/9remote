// Manages all active AI sessions across Claude, Codex, and OpenCode
import fs from "node:fs";
import { execFile } from "node:child_process";
import { AI_ENGINES, ORPHAN_SWEEP_INTERVAL_MS, AI_IDLE_TICK_MS, STALE_CHAT_MS, ORPHAN_CLAUDE_GRACE_MS } from "./constants.js";
import { AiSession, aiSnapshotFile } from "./aiSession.js";
import * as daemonClient from "../terminal/ptyDaemonClient.js";
import { createLogger } from "../../lib/logger.js";
import { registerDoneReleaser } from "../terminal/statusManager.js";
import { queueSkillInstall } from "../browserUse/skill.js";

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
    queueSkillInstall(engine);
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
// forever — the daemon has no owner of its own. A chat owns its proc only while live
// in memory or with a snapshot touched within STALE_CHAT_MS (snapshots are rewritten
// on every turn event, so an active chat's file is always fresh); anything else in
// the daemon's proc map is reclaimable — a prompt respawns it via --resume.
function chatActive(procId) {
  if (globalAiManager.sessions.has(procId)) return true;
  const now = Date.now();
  return Object.values(AI_ENGINES).some((engine) => {
    try { return now - fs.statSync(aiSnapshotFile(procId, engine)).mtimeMs < STALE_CHAT_MS; } catch { return false; }
  });
}

// Delete a chat this host run never loaded (the delete arrived before any open):
// destroySession alone cannot reach it, so stop its daemon proc and drop its snapshots.
export async function destroyDetachedChat(chatId, client = daemonClient) {
  await client.procStop(chatId).catch(() => {});
  for (const engine of Object.values(AI_ENGINES)) {
    try { fs.unlinkSync(aiSnapshotFile(chatId, engine)); } catch {}
  }
}

export async function sweepOrphanProcs(client = daemonClient) {
  if (!client.isConnected()) return;
  try {
    const held = await client.procList();
    const procs = Array.isArray(held) ? held : held?.procs || [];
    for (const proc of procs) {
      const id = proc?.procId || proc?.id;
      if (!id || chatActive(id)) continue;
      // Re-check at kill time: a chat created after the list was fetched is in the map
      // before its first proc RPC can land.
      await new Promise((resolve) => setImmediate(resolve));
      if (chatActive(id)) continue;
      await client.procStop(id);
      logger.info(`[proc-sweep] stopped orphan daemon proc ${id} (${proc.total || 0} lines buffered)`);
    }
  } catch {
    // The daemon is optional; the next tick retries.
  }
}

// `ps` elapsed formats — mm:ss | hh:mm:ss | dd-hh:mm:ss. 0 when unparsable.
export function etimeSeconds(raw) {
  const parts = String(raw || "").trim().split(/[-:]/).map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return 0;
  while (parts.length < 4) parts.unshift(0);
  const [d, h, m, s] = parts;
  return ((d * 24 + h) * 60 + m) * 60 + s;
}

// Orphaned claude processes, reparented to PID 1 when their parent died (daemon
// crash, or claude's own subagent-orphan upstream bug). PPID=1 + age is the orphan
// proof: daemon-held CLIs have the daemon as parent, and a user's terminal claude
// has a shell — only a dead parent leaves launchd as the foster one.
export function parseOrphanClaude(lines) {
  const out = [];
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s+1\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, pgid, etime, args] = m;
    const bin = (args.split(/\s+/)[0] || "").split("/").pop();
    if (bin !== "claude") continue;
    if (etimeSeconds(etime) * 1000 < ORPHAN_CLAUDE_GRACE_MS) continue;
    out.push({ pid: Number(pid), pgid: Number(pgid) });
  }
  return out;
}

export function killOrphanClaudeProcs() {
  if (process.platform === "win32") return;
  execFile("ps", ["-Ao", "pid,ppid,pgid,etime,args"], { timeout: 5000 }, (err, stdout) => {
    // ps is best-effort; the next sweep tick retries.
    if (err) return;
    for (const { pid, pgid } of parseOrphanClaude(stdout.split("\n"))) {
      try { process.kill(-pgid, "SIGINT"); } catch { continue; }
      // SIGKILL stays armed: an INT-ignoring orphan would outlive the graceful pass.
      const timer = setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch {} }, 3000);
      timer.unref?.();
      logger.info(`[proc-sweep] killed orphan claude proc ${pid} (group ${pgid})`);
    }
  });
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

// The orphaned-claude scan needs no daemon — a dead daemon is exactly when its
// CLIs turn into orphans — so it runs on its own cadence from boot.
setInterval(killOrphanClaudeProcs, ORPHAN_SWEEP_INTERVAL_MS).unref?.();
killOrphanClaudeProcs();

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
