// AI Socket.IO protocol handler for 9remote
import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";

export function setupAiHandlers(socket, bus, manager = globalAiManager) {
  // 1. Forward events from AiManager to client bus
  const unsubscribe = manager.onEvent((sessionId, event, data) => {
    bus?.broadcast?.(AI_SOCKET_EVENTS.EVENT, { sessionId, event, data });
  });

  socket.on("disconnect", () => {
    unsubscribe?.();
  });

  // 2. Client requests
  socket.on(AI_SOCKET_EVENTS.CREATE, ({ sessionId, engine, cwd, options = {}, mock = false }, cb) => {
    try {
      if (!sessionId || !engine) throw new Error("Missing sessionId or engine");
      const session = manager.createSession(sessionId, engine, cwd, { ...options, mock });
      cb?.({ ok: true, sessionId: session.id, engine: session.engine, cwd: session.cwd });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, ({ sessionId, message }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.sendPrompt(message);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PERMISSION, ({ sessionId, requestId, behavior, message }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.resolvePermission(requestId, behavior, message);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.QUESTION, ({ sessionId, requestId, answers }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.resolveQuestion(requestId, answers);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.STOP, ({ sessionId }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (session) session.stop();
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.OPTIONS, ({ sessionId, options }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (session) session.setOptions(options);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.DESTROY, ({ sessionId }, cb) => {
    try {
      manager.destroySession(sessionId);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.LIST, (data, cb) => {
    try {
      cb?.({ ok: true, sessions: manager.listSessions() });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });
}
