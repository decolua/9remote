// AI Socket.IO protocol handler for 9remote
import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { listSkills } from "./skills.js";
import { listMcpServers } from "./mcp.js";
import { searchRepoFiles } from "./files.js";
import { runEngineDoctor } from "./aiSession.js";
import { renameSessionTitle, broadcastAiStatus } from "../terminal/terminalSocket.js";
import * as daemonClient from "../terminal/ptyDaemonClient.js";

const logger = createLogger("ai");
let broadcastAttached = false;
let daemonAiAttached = false;

// Claude sessions live in the PTY daemon (survive agent restarts, shared by
// every client). ponytail: codex/opencode stay on the in-agent manager until
// their stream protocols move into the daemon too.
function aiUsesDaemon(engine, mock = false) {
  return engine === "claude" && !mock && daemonClient.isConnected();
}

function mirrorAiStatus(sessionId, event, engine) {
  if (event === "permission_request") broadcastAiStatus?.(sessionId, "blocked", engine);
  else if (event === "turn_complete") broadcastAiStatus?.(sessionId, "done", engine);
  else if (event === "user_message") broadcastAiStatus?.(sessionId, "working", engine);
}

export function setupAiHandlers(socket, io, manager = globalAiManager) {
  // 1. Forward events from AiManager to clients exactly ONCE via global broadcast
  if (io && !broadcastAttached) {
    broadcastAttached = true;
    manager.onEvent((sessionId, event, data) => {
      logger.debug(`[ai] event: ${event} session: ${sessionId}`);
      broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event, data });
      mirrorAiStatus(sessionId, event, manager.getSession(sessionId)?.engine || "claude");
    });
  }

  // 1b. Forward daemon-owned AI events to clients exactly ONCE
  if (io && !daemonAiAttached) {
    daemonAiAttached = true;
    daemonClient.on("aiEvent", ({ sessionId, event, data, seq } = {}) => {
      if (!sessionId || !event) return;
      // seq rides along so a hydrating client can drop events it already replayed
      broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event, data, seq });
      mirrorAiStatus(sessionId, event, "claude");
    });
  }

  // Fallback for tests or direct socket mocking
  if (!io || typeof io.emit !== "function") {
    const unsubscribe = manager.onEvent((sessionId, event, data) => {
      try {
        socket.emit(AI_SOCKET_EVENTS.EVENT, { sessionId, event, data });
      } catch {}
    });
    socket.on("disconnect", () => {
      unsubscribe?.();
    });
  }

  // 2. Client requests
  socket.on(AI_SOCKET_EVENTS.CREATE, async ({ sessionId, engine, cwd, options = {}, mock = false }, cb) => {
    try {
      if (!sessionId || !engine) throw new Error("Missing sessionId or engine");
      logger.info(`[ai] create session: ${sessionId} engine: ${engine} cwd: ${cwd}`);
      if (aiUsesDaemon(engine, mock)) {
        const res = await daemonClient.createAiSession(sessionId, engine, cwd, options);
        if (!res.success) throw new Error(res.error || "Daemon AI create failed");
        // Skills/MCP are discovered agent-side (filesystem), not by the CLI — merge
        // them into the state the client hydrates so the modals aren't empty.
        const skills = listSkills(engine, cwd);
        const mcpServers = listMcpServers(engine);
        broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event: "init", data: { skills, mcpServers } });
        // Full state back so any client (web/agent UI/mobile) hydrates the same history
        cb?.({ ok: true, sessionId, engine, cwd, session: res.session });
        return;
      }
      const session = manager.createSession(sessionId, engine, cwd, { ...options, mock });
      const skills = listSkills(engine, cwd);
      const mcpServers = listMcpServers(engine);
      // Kept on the session so a Clear can re-seed the log with the same metadata
      session.skills = skills;
      // Already-hydrated sessions skip the append: this runs on every connect (F5,
      // extra tab), and a log that grew an `init` per connect would never stop growing.
      // The event is still broadcast so the joining client sees the current metadata.
      session.emitNormalized("init", { skills, mcpServers }, !session.hasRecordedInit());
      cb?.({
        ok: true,
        sessionId: session.id,
        engine: session.engine,
        cwd: session.cwd,
        skills,
        mcpServers,
        session: {
          events: session.history,
          isTurnRunning: session.isTurnRunning,
          seq: session.history.length
        }
      });
    } catch (err) {
      logger.error(`[ai] create failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, async ({ sessionId, message, cwd }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        const res = await daemonClient.aiPrompt(sessionId, message, cwd || null);
        if (!res.success) throw new Error(res.error || "Daemon AI prompt failed");
        renameSessionTitle?.(sessionId, message);
        cb?.({ ok: true });
        return;
      }
      let session = manager.getSession(sessionId);
      if (!session) {
        logger.warn(`[ai] session ${sessionId} not found on prompt, auto-creating with claude`);
        session = manager.createSession(sessionId, "claude", process.cwd());
      }
      logger.info(`[ai] prompt: ${sessionId} (engine: ${session.engine}): ${message?.slice(0, 60)}`);
      // User message is emitted via session.sendPrompt -> emitNormalized -> broadcast
      session.sendPrompt(message);
      renameSessionTitle?.(sessionId, message);
      broadcastAiStatus?.(sessionId, "working", session.engine);
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] prompt failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PERMISSION, async ({ sessionId, requestId, behavior, message }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        const res = await daemonClient.aiPermission(sessionId, requestId, behavior, message);
        if (!res.success) throw new Error(res.error || "Daemon AI permission failed");
        cb?.({ ok: true });
        return;
      }
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.resolvePermission(requestId, behavior, message);
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] permission failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.QUESTION, async ({ sessionId, requestId, answers }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        const res = await daemonClient.aiQuestion(sessionId, requestId, answers);
        if (!res.success) throw new Error(res.error || "Daemon AI question failed");
        cb?.({ ok: true });
        return;
      }
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.resolveQuestion(requestId, answers);
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] question failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.STOP, async ({ sessionId }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        await daemonClient.aiStop(sessionId);
        broadcastAiStatus?.(sessionId, "idle", "claude");
        cb?.({ ok: true });
        return;
      }
      const session = manager.getSession(sessionId);
      if (session) {
        session.stop();
        broadcastAiStatus?.(sessionId, "idle", session.engine);
      }
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.OPTIONS, async ({ sessionId, options }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        await daemonClient.aiOptions(sessionId, options);
        cb?.({ ok: true });
        return;
      }
      const session = manager.getSession(sessionId);
      if (session) session.setOptions(options);
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on("ai:files", ({ workspace, query, limit = 25 }, cb) => {
    try {
      const files = searchRepoFiles(workspace, query, limit);
      cb?.({ ok: true, files });
    } catch (err) {
      cb?.({ ok: false, error: err.message, files: [] });
    }
  });

  // Run the engine CLI's health command on the host. Uses the static doctor spec,
  // so a session is neither required nor created (constructing one would spawn a
  // real CLI process just to read a command name).
  socket.on("ai:doctor", async ({ sessionId, engine = "claude", cwd }, cb) => {
    try {
      const res = await runEngineDoctor(engine, cwd || process.cwd());
      cb?.(res);
    } catch (err) {
      logger.error(`[ai] doctor failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.DESTROY, async ({ sessionId }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        await daemonClient.destroyAiSession(sessionId);
      }
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
