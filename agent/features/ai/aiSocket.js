// AI Socket.IO protocol handler for 9remote
import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { listSkills } from "./skills.js";
import { listMcpServers } from "./mcp.js";
import { searchRepoFiles } from "./files.js";
import { listModelOptions, listCodexModelOptions, listOpencodeModelOptions, resolveDefaultModel } from "./models.js";
import { runEngineDoctor } from "./aiSession.js";
import { renameSessionTitle, broadcastAiStatus } from "../terminal/terminalSocket.js";
import { getConversation, getSessionAgent, setConversationId } from "../terminal/statusManager.js";
import { engineFromAgent } from "../terminal/conversationModes.js";
import { SESSION_ID_RE } from "../terminal/agentCatalog.js";
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

// Model ids the host's own CLI offers, per engine. Null means the engine's registry
// list is authoritative (antigravity ships its own catalog).
function listModelOptionsFor(engine) {
  if (engine === "claude") return listModelOptions();
  if (engine === "codex") return listCodexModelOptions();
  if (engine === "opencode") return listOpencodeModelOptions();
  return null;
}

// The model a fresh chat runs with, so the picker shows the CLI's own default before
// the first turn rather than an empty "Model". The engine's fallback is only a last
// resort: a host-specific id must never be replaced by a canned one.
function defaultModelFor(engine) {
  return resolveDefaultModel(engine) || "";
}

// A chat UI session runs its CLI without the PTY's session env, so no hook ever
// reports its conversation id — the init event is the only place it surfaces.
// Recording it is what lets the history list reopen this chat as a chat.
// The surface is the session's, not the engine's: persisted metadata takes the
// conversation's agent over the session's own, so "claude" here would restore a
// chat as a plain terminal on the next boot.
function mirrorAiConversation(sessionId, event, data, engine) {
  if (event !== "init" || !data?.sessionId) return;
  if (!SESSION_ID_RE.test(data.sessionId)) return;
  setConversationId(sessionId, getSessionAgent(sessionId) || engine, data.sessionId, "hook");
}

export function setupAiHandlers(socket, io, manager = globalAiManager) {
  // 1. Forward events from AiManager to clients exactly ONCE via global broadcast
  if (io && !broadcastAttached) {
    broadcastAttached = true;
    manager.onEvent((sessionId, event, data) => {
      logger.debug(`[ai] event: ${event} session: ${sessionId}`);
      broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event, data });
      const engine = manager.getSession(sessionId)?.engine || "claude";
      mirrorAiStatus(sessionId, event, engine);
      mirrorAiConversation(sessionId, event, data, engine);
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
      mirrorAiConversation(sessionId, event, data, "claude");
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
      // A terminal holding a CLI conversation that is now opening as a chat: bind the
      // chat to that conversation, so the pane shows it rather than an empty one. The
      // client is not asked to know this — the host records which chat each terminal runs.
      const conv = getConversation(sessionId);
      const resumeId = options.cliSessionId || (engineFromAgent(conv?.agent) === engine ? conv.id : null);
      const spawnOptions = resumeId ? { ...options, cliSessionId: resumeId } : options;
      if (aiUsesDaemon(engine, mock)) {
        const res = await daemonClient.createAiSession(sessionId, engine, cwd, spawnOptions);
        if (!res.success) throw new Error(res.error || "Daemon AI create failed");
        // A daemon session can already exist with no conversation bound to it (the pane
        // mounts before the switch lands). createAiSession reuses it as-is, so the id has
        // to be bound here — aiOptions rebinds the CLI, restarts it against the resumed
        // transcript and replays that log to the client.
        if (resumeId && !res.session?.cliSessionId) {
          await daemonClient.aiOptions(sessionId, { resume: resumeId });
        }
        // Skills/MCP are discovered agent-side (filesystem), not by the CLI — merge
        // them into the state the client hydrates so the modals aren't empty.
        const skills = listSkills(engine, cwd);
        const mcpServers = listMcpServers(engine);
        // Host-specific model ids — each CLI is asked for its own catalog, since the
        // ids only exist on the machine whose config points at a gateway.
        const modelOptions = listModelOptionsFor(engine);
        // The session's own model, not the host default: this init also fires for a
        // chat that is merely being reopened, and a picked model must survive that.
        const model = res.session?.model || defaultModelFor(engine);
        broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event: "init", data: { skills, mcpServers, modelOptions, model } });
        // Full state back so any client (web/agent UI/mobile) hydrates the same history
        cb?.({ ok: true, sessionId, engine, cwd, session: res.session });
        return;
      }
      const session = manager.createSession(sessionId, engine, cwd, { ...spawnOptions, mock });
      const skills = listSkills(engine, cwd);
      const mcpServers = listMcpServers(engine);
      const modelOptions = listModelOptionsFor(engine);
      // Kept on the session so a Clear can re-seed the log with the same metadata
      session.skills = skills;
      // Already-hydrated sessions skip the append: this runs on every connect (F5,
      // extra tab), and a log that grew an `init` per connect would never stop growing.
      // The event is still broadcast so the joining client sees the current metadata.
      session.emitNormalized("init", { skills, mcpServers, modelOptions, model: session.model || defaultModelFor(engine) }, !session.hasRecordedInit());
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
          seq: session.history.length,
          // The mode the adapter was built with. A new session has an empty log, so
          // the replay carries nothing to derive it from — without this the client
          // shows the picker's first entry while the CLI runs something else.
          permissionMode: session.permissionMode,
          model: session.model,
          effort: session.options?.effort || ""
        }
      });
    } catch (err) {
      logger.error(`[ai] create failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, async ({ sessionId, message, cwd, attachments }, cb) => {
    try {
      if (aiUsesDaemon("claude") && !manager.getSession(sessionId)) {
        const res = await daemonClient.aiPrompt(sessionId, message, cwd || null, attachments);
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
      session.sendPrompt(message, attachments);
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
