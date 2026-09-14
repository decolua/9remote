// AI Socket.IO protocol handler for 9remote
import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { listSkills } from "./skills.js";
import { listMcpServers } from "./mcp.js";
import { searchRepoFiles } from "./files.js";
import { listModelOptions, listCodexModelOptions, listOpencodeModelOptions, resolveDefaultModel, resolveDefaultEffort } from "./models.js";
import { runEngineDoctor, TURN_END_EVENTS } from "./aiSession.js";
import { broadcastAiStatus } from "../terminal/terminalSocket.js";
import { getConversation, getSessionAgent, setConversationId } from "../terminal/statusManager.js";
import { engineFromAgent } from "../terminal/conversationModes.js";
import { SESSION_ID_RE } from "../terminal/agentCatalog.js";
import { replayWindow } from "./aiEventSlice.js";
import { AI_REPLAY_BYTES, AI_ENGINES } from "./constants.js";
import { rewindSupport, unsupportedReason } from "./rewind.js";
import { listRewindPoints, rewindable, previewRewind, applyRewind } from "./opencodeRewind.js";
import * as claudeRewind from "./claudeRewind.js";

const logger = createLogger("ai");
let broadcastAttached = false;
// session ids whose async create is still in flight. Two mounts of the same pane (a
// reconnect, a second tab) both miss the "already live" check while the first is still
// awaiting its CLI, and would then build and start it twice — the second create killing
// the first one's process. One shared set; keys are session-scoped, not connection-scoped.
const creating = new Map();

// The tab dot / bell / push all read statusManager, and a chat UI session has no PTY
// hook to feed it — this is the only writer of its state. Every event the session
// emits passes through here, so a turn that is refused or dies mid-flight still
// lands on a state instead of leaving the dot spinning until the reaper clears it.
function mirrorAiStatus(sessionId, event, data, engine) {
  if (event === "permission_request") broadcastAiStatus?.(sessionId, "blocked", engine, data);
  else if (event === "turn_complete") broadcastAiStatus?.(sessionId, "done", engine, data);
  else if (TURN_END_EVENTS.has(event)) broadcastAiStatus?.(sessionId, "idle", engine, data);
  else if (event === "user_message") broadcastAiStatus?.(sessionId, "working", engine, data);
}

// Model ids the host's own CLI offers, per engine. Null means the engine's registry
// list is authoritative (antigravity ships its own catalog).
// What a hydrating client gets: the tail of the log, not the whole thing. A real chat
// measured 6.9 MB of events, and shipping that on every mount is what stalls a phone.
// `hasMore` is what arms the client's scroll-up fetch, so it must travel with the tail.
function publicSession(session, extra = {}) {
  const { events, hasMore } = replayWindow(session.history, AI_REPLAY_BYTES);
  return {
    events,
    hasMore,
    isTurnRunning: session.isTurnRunning,
    // The newest seq, NOT the array length: past AI_MAX_EVENTS the log sheds its head,
    // so length stops equalling the highest seq and the client would swallow an event.
    seq: session.history.at(-1)?.seq ?? 0,
    permissionMode: session.permissionMode,
    model: session.model,
    // The session's own pick, snapshot-restored. Empty means "the CLI's config decides",
    // which the init event states — this only overrides it once the user has chosen.
    effort: session.effort || "",
    // Usage the replay cannot reconstruct: the adapter's counters are what the status
    // bar reads, and a log holds only the events, not the running totals. Without this
    // a fresh load showed an empty context row while the CLI held tens of thousands.
    stats: session.adapter?.stats || null,
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

// The effort the CLI would run with on its own. Published for display only, exactly
// like defaultModelFor: forcing it into argv would override a project-level setting.
function defaultEffortFor(engine) {
  return resolveDefaultEffort(engine) || "";
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
      mirrorAiStatus(sessionId, event, data, engine);
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
    // TEMP DIAGNOSTIC — every create the host receives, and which branch answered it.
    // A hydrate that shows "Syncing…" forever with no "create recv" line here means the
    // request never reached the host at all. Remove with the rest of the ai-hydrate logs.
    const recvAt = Date.now();
    logger.info(`[ai] create recv: ${sessionId} engine=${engine} (syncClientSession)`);
    try {
      if (!sessionId || !engine) throw new Error("Missing sessionId or engine");
      // A create repeats on every mount (F5, second tab). The live session is already
      // this chat, so re-creating it would kill its CLI and lose the turn in flight.
      if (manager.getSession(sessionId)) {
        const existing = manager.getSession(sessionId);
        logger.info(`[ai] create → live session (${Date.now() - recvAt}ms)`);
        return cb?.({
          ok: true,
          sessionId,
          engine,
          cwd: existing.cwd,
          skills: existing.skills,
          session: publicSession(existing)
        });
      }
      // A create already on its way for this session: the caller waits for THAT one and
      // gets its result, instead of starting a second CLI on the same conversation.
      if (creating.has(sessionId)) {
        const { session, done } = creating.get(sessionId);
        logger.info(`[ai] create → waiting on in-flight create`);
        await done;
        logger.info(`[ai] create → in-flight create done (${Date.now() - recvAt}ms)`);
        return cb?.({
          ok: true,
          sessionId,
          engine,
          cwd: session.cwd,
          skills: session.skills,
          session: publicSession(session)
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
      let releaseCreate;
      creating.set(sessionId, { session, done: new Promise((r) => { releaseCreate = r; }) });
      try {
        // TEMP DIAGNOSTIC — a fresh spawn is the branch that can hang: `ready` resolves
        // on the CLI's first init, and a CLI that never prints one leaves the client's
        // ack outstanding forever. Remove with the rest of the ai-hydrate logs.
        await session.ready;
        logger.info(`[ai] create → spawned, ready in ${Date.now() - recvAt}ms`);
      } finally {
        creating.delete(sessionId);
        releaseCreate();
      }
      const skills = listSkills(engine, cwd);
      const mcpServers = listMcpServers(engine);
      const modelOptions = listModelOptionsFor(engine);
      // A re-attach that finds the log thinner than the CLI's own transcript rebuilds it
      // BEFORE the ack snapshots a window over it. Without this the pane is answered from
      // the agent's log — which the event cap and a legacy snapshot can leave short — and
      // the missing turns are not merely unshown: the ack's `fromSeq` tells the client
      // where its window begins, so its scroll-up never asks for them.
      session.recoverIfThinner();
      // Kept on the session so a Clear can re-seed the log with the same metadata
      session.skills = skills;
      // Already-hydrated sessions skip the append: this runs on every connect (F5,
      // extra tab), and a log that grew an `init` per connect would never stop growing.
      // The event is still broadcast so the joining client sees the current metadata.
      session.emitNormalized("init", {
        skills,
        mcpServers,
        modelOptions,
        model: session.model || defaultModelFor(engine),
        // The session's own pick wins; otherwise the CLI's config is what it will run
        // with, and that is what the composer must show beside the model.
        effort: session.effort || defaultEffortFor(engine)
      }, !session.hasRecordedInit());
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
      // TEMP DIAGNOSTIC — the host DID answer, with a failure. Without this line the
      // client's `ok:false` looks identical to a carrier that ate the ack.
      logger.error(`[ai] create failed after ${Date.now() - recvAt}ms: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, async ({ sessionId, message, cwd, attachments }, cb) => {
    try {
      let session = manager.getSession(sessionId);
      if (!session) {
        logger.warn(`[ai] session ${sessionId} not found on prompt, auto-creating with claude`);
        // A create already in flight owns this id — wait for its session rather than
        // building a second CLI that would then be torn down by the first.
        if (creating.has(sessionId)) {
          await creating.get(sessionId).done;
          session = manager.getSession(sessionId);
        }
        if (!session) {
          // cwd rides along so the raced session lands in the right directory, not $HOME
          session = manager.createSession(sessionId, "claude", cwd || process.cwd(), { defaultModel: defaultModelFor("claude") });
          await session.ready;
        }
      }
      if (!session) throw new Error(`AI session unavailable: ${sessionId}`);
      logger.info(`[ai] prompt: ${sessionId} (engine: ${session.engine}): ${message?.slice(0, 60)}`);
      // /clear is a host-side reset, not a message. The pane has already dropped its own
      // log by the time this arrives, so a refusal (the turn is still running) leaves the
      // user staring at an empty chat with no way back. Stop the turn first and let the
      // reset through — which is what "clear" means.
      if (String(message).trim() === "/clear" && session.isTurnRunning) session.stop();
      // User message is emitted via session.sendPrompt -> emitNormalized -> broadcast
      session.sendPrompt(message, attachments);
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

  // What can this session rewind to, and can it rewind at all?
  socket.on(AI_SOCKET_EVENTS.REWIND, async ({ sessionId, action = "list", messageId, files = true }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      const engine = session?.engine || "claude";
      const support = rewindSupport(engine);
      if (!support.conversation) {
        return cb?.({ ok: false, error: unsupportedReason(engine), support });
      }
      // Claude reads its own transcript off disk; opencode goes through its server.
      const isClaude = engine === AI_ENGINES.CLAUDE;
      // opencode's `rewindable` proves the id exists in its DB; Claude's proof is the
      // transcript file, which also carries the uuids the rewind flags take.
      const convId = isClaude
        ? (claudeRewind.findTranscript(session?.cliSessionId) ? session.cliSessionId : null)
        : rewindable(engine, session?.cliSessionId);
      if (!convId) {
        return cb?.({ ok: false, error: `This conversation is not one ${engine} can rewind.`, support });
      }
      const list = isClaude ? claudeRewind.listRewindPoints : listRewindPoints;
      const preview = isClaude ? claudeRewind.previewRewind : previewRewind;
      if (action === "list") {
        return cb?.({ ok: true, support, points: list(convId) });
      }
      if (!messageId) return cb?.({ ok: false, error: "Missing messageId", support });
      if (action === "preview") {
        return cb?.({ ok: true, support, ...(await preview(convId, messageId, { files })) });
      }
      if (action === "apply") {
        // A rewind rewrites the conversation the CLI is holding. The running turn is
        // not part of any checkpoint, so applying mid-turn would strand it.
        if (session.isTurnRunning) {
          return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
        }
        // Claude's file half is a one-shot CLI run that needs the session's cwd.
        const result = isClaude
          ? await claudeRewind.applyRewind(convId, messageId, { files, cwd: session.cwd })
          : await applyRewind(convId, messageId, { files });
        if (!result.ok) return cb?.({ ok: false, error: result.error, support });
        // Claude cut the thread into a NEW session id. Rebind to it, or the pane would
        // show the rewound conversation while the CLI keeps appending to the old one.
        if (result.newSessionId) session.setOptions({ resume: result.newSessionId });
        // The CLI's own store is now the shortened conversation. Rebuild the host's log
        // from it and broadcast a reset, or every client keeps rendering the turns the
        // rewind just discarded.
        session.reloadFromStore?.();
        return cb?.({ ok: true, support, ...result });
      }
      cb?.({ ok: false, error: `Unknown rewind action: ${action}`, support });
    } catch (err) {
      logger.error(`[ai] rewind failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });
}
