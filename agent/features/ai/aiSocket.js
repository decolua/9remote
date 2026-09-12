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
import { aiTailStart } from "./aiEventSlice.js";
import { AI_REPLAY_BYTES } from "./constants.js";

const logger = createLogger("ai");
let broadcastAttached = false;

function mirrorAiStatus(sessionId, event, engine) {
  if (event === "permission_request") broadcastAiStatus?.(sessionId, "blocked", engine);
  else if (event === "turn_complete") broadcastAiStatus?.(sessionId, "done", engine);
  else if (event === "user_message") broadcastAiStatus?.(sessionId, "working", engine);
}

// Model ids the host's own CLI offers, per engine. Null means the engine's registry
// list is authoritative (antigravity ships its own catalog).
// What a hydrating client gets: the tail of the log, not the whole thing. A real chat
// measured 6.9 MB of events, and shipping that on every mount is what stalls a phone.
// `hasMore` is what arms the client's scroll-up fetch, so it must travel with the tail.
function publicSession(session, extra = {}) {
  const from = aiTailStart(session.history, AI_REPLAY_BYTES);
  return {
    events: from > 0 ? session.history.slice(from) : session.history,
    hasMore: from > 0,
    isTurnRunning: session.isTurnRunning,
    // The newest seq, NOT the array length: past AI_MAX_EVENTS the log sheds its head,
    // so length stops equalling the highest seq and the client would swallow an event.
    seq: session.history.at(-1)?.seq ?? 0,
    permissionMode: session.permissionMode,
    model: session.model,
    effort: session.options?.effort || "",
    ...extra
  };
}

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
      // A create repeats on every mount (F5, second tab). The live session is already
      // this chat, so re-creating it would kill its CLI and lose the turn in flight.
      if (manager.getSession(sessionId)) {
        const existing = manager.getSession(sessionId);
        return cb?.({
          ok: true,
          sessionId,
          engine,
          cwd: existing.cwd,
          skills: existing.skills,
          session: publicSession(existing)
        });
      }
      logger.info(`[ai] create session: ${sessionId} engine: ${engine} cwd: ${cwd}`);
      // A terminal holding a CLI conversation that is now opening as a chat: bind the
      // chat to that conversation, so the pane shows it rather than an empty one. The
      // client is not asked to know this — the host records which chat each terminal runs.
      const conv = getConversation(sessionId);
      const resumeId = options.cliSessionId || (engineFromAgent(conv?.agent) === engine ? conv.id : null);
      // The model default is resolved here, by the host — an engine adapter must never
      // read the machine's config on its own path.
      const spawnOptions = {
        ...(resumeId ? { ...options, cliSessionId: resumeId } : options),
        defaultModel: defaultModelFor(engine)
      };
      const session = manager.createSession(sessionId, engine, cwd, { ...spawnOptions, mock });
      await session.ready;
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
        // The mode travels too: a new session has an empty log, so the replay carries
        // nothing to derive it from — without it the client shows the picker's first
        // entry while the CLI runs something else.
        session: publicSession(session)
      });
    } catch (err) {
      logger.error(`[ai] create failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, async ({ sessionId, message, cwd, attachments }, cb) => {
    try {
      let session = manager.getSession(sessionId);
      if (!session) {
        logger.warn(`[ai] session ${sessionId} not found on prompt, auto-creating with claude`);
        // cwd rides along so the raced session lands in the right directory, not $HOME
        session = manager.createSession(sessionId, "claude", cwd || process.cwd(), { defaultModel: defaultModelFor("claude") });
        await session.ready;
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
