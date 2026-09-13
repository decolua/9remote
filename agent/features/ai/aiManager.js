// Manages all active AI sessions across Claude, Codex, and OpenCode
import { AI_ENGINES } from "./constants.js";
import { AiSession } from "./aiSession.js";

export class AiManager {
  constructor() {
    this.sessions = new Map();
    this.eventListeners = new Set();
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  broadcastEvent(sessionId, event, data) {
    for (const listener of this.eventListeners) {
      try {
        listener(sessionId, event, data);
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
      onEvent: (sId, event, data) => this.broadcastEvent(sId, event, data)
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
