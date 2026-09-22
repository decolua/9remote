import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { listSkills } from "./skills.js";
import { listMcpServers } from "./mcp.js";
import { searchRepoFiles } from "./files.js";
import { listModelOptions, listCodexModelOptions, listOpencodeModelOptions, listOpencodeModelOptionsFromServer, listAllOpencodeModelOptions, listAntigravityModelOptions, listOmpModelOptions, listDevinModelOptions, resolveDefaultModel, resolveDefaultEffort } from "./models.js";
import { runEngineDoctor } from "./aiSession.js";
import { EVENT_TO_STATE, restatesOverGate } from "./aiStatus.js";
import { broadcastAiStatus, listSessionRoots } from "../terminal/terminalSocket.js";
import { getConversation, getSessionAgent, setConversationId, getStatus, touchWorking, requestAutoName } from "../terminal/statusManager.js";
import { engineFromAgent } from "../terminal/conversationModes.js";
import { SESSION_ID_RE } from "../terminal/agentCatalog.js";
import { replayWindow } from "./aiEventSlice.js";
import { AI_REPLAY_BYTES, AI_ENGINES, AI_MODEL_CACHE_TTL_MS } from "./constants.js";
import { rewindSupport, unsupportedReason, resolveRewindTarget } from "./rewind.js";
import { listRewindPoints, rewindable, previewRewind, applyRewind } from "./opencodeRewind.js";
import * as claudeRewind from "./claudeRewind.js";
import * as codexRewind from "./codexRewind.js";

const logger = createLogger("ai");

// The terminal's live cwd beats the client's copy — a chat must land where its terminal stands.
function liveTerminalCwd(sessionId) {
  return listSessionRoots().find((s) => s.id === sessionId)?.cwd || null;
}

// CLI refusals phrased as "reload and try again", not protocol errors handed back.
const REWIND_REFUSALS = {
  stale_target: "That turn is no longer in this conversation. Reload the chat and try again.",
  unseen_later_turn: "This chat has turns newer than the one being rewound. Reload and try again."
};

const CONVERSATION_ONLY_NOTE = "No file changes to restore — this rewinds the conversation only.";

// Codex rewind is its own protocol: turns read from the live thread, no file half, reload makes the cut visible.
async function rewindForCodex({ cb, session, support, points, action, messageId, index }) {
  if (action === "list") {
    return cb?.({
      ok: points.length > 0,
      support,
      points,
      ...(points.length > 0 ? {} : { error: "This conversation has no turn to rewind to yet." })
    });
  }
  const target = messageId || resolveRewindTarget(points, index);
  if (!target) {
    return cb?.({
      ok: false,
      error: "That turn is no longer in this conversation. Reload the chat and try again.",
      support
    });
  }
  if (action === "preview") {
    const res = await codexRewind.previewRewind(session, target);
    return cb?.({ ok: res.ok, support, ...res });
  }
  if (action === "apply") {
    // A running turn is outside the history being cut; rewinding under it would strand it.
    if (session.isTurnRunning) {
      return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
    }
    const result = await codexRewind.applyRewind(session, target);
    if (!result.ok) return cb?.({ ok: false, error: result.error, support });
    // Rebuild + reset broadcast, or clients keep rendering the discarded turns.
    session.reloadFromStore?.();
    session.turnStartedAt = 0;
    session.lastTurnMs = 0;
    return cb?.({ ok: true, support, ...result });
  }
  cb?.({ ok: false, error: `Unknown rewind action: ${action}`, support });
}

// What this rewind WOULD restore, asked of the CLI; rewind_files is inclusive of the target turn.
async function claudePreview(session, target, { files = true } = {}) {
  // Conversation-only rewind skips the checkpoint walk — the answer is never shown.
  if (!files) {
    return { ok: true, messageId: target, files: [], filesUnknown: false, note: CONVERSATION_ONLY_NOTE };
  }
  const res = await session.adapter?.rewindFiles?.(target, { dryRun: true });
  if (!res) return { ok: false, error: "The CLI did not answer.", messageId: target };
  // A failure must not read as "nothing changes" — the dialog would invite a press on nothing.
  if (res.error) return { ok: false, error: res.error, messageId: target };
  // canRewind:false means no checkpoint for the session at all, not "this rewind changes nothing".
  if (res.canRewind === false) {
    return {
      ok: true,
      messageId: target,
      files: [],
      filesUnknown: true,
      note: "Claude Code has no file checkpoint for this session, so only the conversation is rewound."
    };
  }
  const changed = (res.filesChanged || []).map((file) => ({ file }));
  return {
    ok: true,
    messageId: target,
    files: changed,
    filesUnknown: false,
    note: changed.length > 0
      ? "These files go back to how they were at this prompt, and any file written after it is deleted. Files changed by a shell command are not tracked and stay as they are."
      : "No file changes: nothing has been written since this prompt. The conversation is what gets rewound."
  };
}

// Control requests to the owning CLI: it cuts its own memory and files — no second writer.
async function claudeApply(session, targets, target, { files = true } = {}) {
  const adapter = session.adapter;
  if (!adapter?.rewindConversation) return { ok: false, error: "This chat has no CLI to rewind.", messageId: target };
  // lastSeen = newest turn the caller rendered; the CLI refuses cuts that would drop unseen turns.
  const lastSeen = targets[targets.length - 1]?.messageId || target;
  // CUT first so a refusal costs nothing — files-first could leave a half-rewound state.
  const cut = await adapter.rewindConversation(target, lastSeen);
  if (!cut?.rewound) {
    // Log the refusal — rejected and never-ran look identical on screen otherwise.
    logger.debug(`[ai] rewind refused: target=${target} lastSeen=${lastSeen} reason=${cut?.reason || "-"} error=${cut?.error || "-"}`);
    return {
      ok: false,
      messageId: target,
      error: REWIND_REFUSALS[cut?.reason] || cut?.error || "The CLI did not rewind this conversation."
    };
  }
  // A file failure after the cut is reported as-is — ok:false would make clients revert dropped turns.
  if (files) {
    const done = await adapter.rewindFiles(target);
    if (done?.error) {
      logger.warn(`[ai] rewind: conversation cut, files not restored: ${done.error}`);
      return { ok: true, messageId: target, filesUnknown: true, prefillText: cut.prefillText || "", conversation: true, leaf: cut.precedingAssistantUuid || null };
    }
  }
  // The CLI's copy of the turn that went, for callers with no text of their own (the rewind modal).
  return { ok: true, messageId: target, prefillText: cut.prefillText || "", conversation: true, leaf: cut.precedingAssistantUuid || null };
}
let broadcastAttached = false;
// Session ids whose create is in flight — a second mount waits on it rather than killing the first CLI.
const creating = new Map();

// A chat session has no PTY feeding statusManager — this mirror is its only state writer.
function mirrorAiStatus(manager, sessionId, event, data, engine) {
  // Every event (replays included) is a sign of life — without this the reaper blanks a running turn.
  touchWorking(sessionId);
  // Replayed events carry old endings — mirrored they repaint a live turn as finished on every F5.
  if (data?.replay) return;
  const state = EVENT_TO_STATE[event];
  if (!state) return;
  const gateHeld = manager.getSession(sessionId)?.pendingPermission?.();
  if (restatesOverGate(event, getStatus(sessionId)?.state, gateHeld)) return;
  broadcastAiStatus?.(sessionId, state, engine, data);
}

// Ack order: rebuild from the CLI transcript first, then metadata into the surviving log — reversed, F5 loses restored turns or the catalog.
async function doorSession(session, engine = session.engine) {
  session.refreshFromStore();
  return { ...await emitConnectMetadata(session, engine), session: publicSession(session) };
}

// Replay window plus state a client cannot rebuild from it; only valid after doorSession's rebuild.
export function publicSession(session) {
  const { events, hasMore } = replayWindow(session.history, AI_REPLAY_BYTES);
  return {
    events,
    hasMore,
    isTurnRunning: session.isTurnRunning,
    // Host-clock durations, so a mid-turn join counts from the real start, not its own join.
    elapsedMs: session.turnState().elapsedMs,
    lastTurnMs: session.lastTurnMs || null,
    // Highest seq, NOT length — the log sheds its head past AI_MAX_EVENTS.
    seq: session.history.at(-1)?.seq ?? 0,
    permissionMode: session.permissionMode,
    // Outside the window: a task announced early in a long turn falls outside a 32KB tail.
    taskRecords: session.taskRecords(),
    // Outside the window — the tail cannot be trusted to carry the held gate.
    activePermission: session.pendingPermission?.() || null,
    model: session.model,
    // Empty means the CLI's config decides; only a user pick overrides.
    effort: session.effort || "",
    // The log holds events, not running totals — the status bar reads the adapter's counters.
    stats: session.adapter?.stats || null,
    queue: session.getQueue ? session.getQueue() : []
  };
}

function listModelOptionsFor(engine) {
  if (engine === "claude") return listModelOptions();
  if (engine === "codex") return listCodexModelOptions();
  if (engine === "opencode") return listOpencodeModelOptions();
  if (engine === "antigravity") return listAntigravityModelOptions();
  if (engine === "omp") return listOmpModelOptions();
  if (engine === "devin") return listDevinModelOptions();
  return null;
}

// Two engines answer a catalog read by spawning a CLI — cache it across connects.
const modelCache = new Map();

async function cachedModelOptionsFor(engine) {
  const hit = modelCache.get(engine);
  const now = Date.now();
  if (hit && now - hit.at < AI_MODEL_CACHE_TTL_MS) return hit.options;
  let options;
  if (engine === "opencode") {
    // The serve catalog is the only source carrying limit.context (contextWindow);
    // the CLI spawn stays as the fallback when no server answers.
    options = await listAllOpencodeModelOptions();
    if (!options.length) options = listOpencodeModelOptions();
  } else {
    options = listModelOptionsFor(engine);
  }
  modelCache.set(engine, { at: now, options });
  return options;
}

// The CLI's own default for the picker; a host-specific id must never fall back to a canned one.
function defaultModelFor(engine) {
  return resolveDefaultModel(engine) || "";
}

// Display only: forcing it into argv would override a project-level setting.
function defaultEffortFor(engine) {
  return resolveDefaultEffort(engine) || (engine === "codex" ? "xhigh" : "");
}

// Sent on every create, live sessions too — the replay log carries no modelOptions.
async function emitConnectMetadata(session, engine) {
  const skills = listSkills(engine, session.cwd);
  const mcpServers = listMcpServers(engine, session.cwd);
  // Live '/' menu feed the adapter already fetched (opencode, omp).
  const commands = session.adapter?.metadata?.commands;
  const modelOptions = await cachedModelOptionsFor(engine);
  // Kept on the session so a Clear can re-seed the log with the same metadata
  session.skills = skills;
  // Append init once; broadcast every connect so joiners still see current metadata.
  session.emitNormalized("init", {
    skills,
    mcpServers,
    ...(commands?.length ? { commands } : {}),
    modelOptions,
    model: session.model || defaultModelFor(engine),
    // The session's pick wins; else the CLI's config is what the composer must show.
    effort: session.effort || defaultEffortFor(engine)
  }, !session.hasRecordedInit());
  return { skills, mcpServers, modelOptions };
}

// init is the only place a chat session's conversation id surfaces; persist the terminal's agent, not the engine's.
function mirrorAiConversation(sessionId, event, data, engine) {
  if (event !== "init") return;
  const convId = data?.sessionId || data?.threadId;
  if (!convId || !SESSION_ID_RE.test(convId)) return;
  setConversationId(sessionId, getSessionAgent(sessionId) || engine, convId, "hook");
}

// Only `thread/name/updated` signals a CLI-side rename; the transcript scan cannot see it.
function mirrorThreadName(sessionId, event, data) {
  if (event !== "init" || !data?.threadName) return;
  requestAutoName(sessionId);
}

export function setupAiHandlers(socket, io, manager = globalAiManager) {
  // 1. Forward events from AiManager to clients exactly ONCE via global broadcast
  if (io && !broadcastAttached) {
    broadcastAttached = true;
    manager.onEvent((sessionId, event, data, seq) => {
      // Streaming events fire per chunk — logging them drowns the file.
      if (event !== "delta" && event !== "thinking") logger.debug(`[ai] event: ${event} session: ${sessionId}`);
      // Failures also get a line here — the pane's error cannot be traced back otherwise.
      if (event === "exit" && (data?.error || (data?.code != null && data.code !== 0))) {
        logger.warn(`[ai] exit: session=${sessionId} engine=${manager.getSession(sessionId)?.engine || "claude"} code=${data.code ?? "-"} error=${data.error || "-"}`);
      }
      if (event === "turn_complete" && data?.isError) {
        logger.warn(`[ai] turn failed: session=${sessionId} subtype=${data.subtype || "-"} result=${String(data.result || "").slice(0, 300)}`);
      }
      // seq separates a replayed event from a new one — without it the same prompt arrives twice.
      broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event, data, seq });
      const engine = manager.getSession(sessionId)?.engine || "claude";
      mirrorAiStatus(manager, sessionId, event, data, engine);
      mirrorAiConversation(sessionId, event, data, engine);
      mirrorThreadName(sessionId, event, data);
    });
  }

  // Fallback for tests or direct socket mocking
  if (!io || typeof io.emit !== "function") {
    const unsubscribe = manager.onEvent((sessionId, event, data, seq) => {
      try {
        socket.emit(AI_SOCKET_EVENTS.EVENT, { sessionId, event, data, seq });
      } catch {}
    });
    socket.on("disconnect", () => {
      unsubscribe?.();
    });
  }

  // 2. Client requests
  socket.on(AI_SOCKET_EVENTS.CREATE, async ({ sessionId, engine, cwd, options = {}, mock = false }, cb) => {
    const recvAt = Date.now();
    logger.info(`[ai] create recv: ${sessionId} engine=${engine} (syncClientSession)`);
    try {
      if (!sessionId || !engine) throw new Error("Missing sessionId or engine");
      const liveCwd = liveTerminalCwd(sessionId);
      if (liveCwd) cwd = liveCwd;
      // A create repeats per mount; re-creating would kill the live CLI and its in-flight turn.
      if (manager.getSession(sessionId)) {
        const existing = manager.getSession(sessionId);
        logger.info(`[ai] create → live session (${Date.now() - recvAt}ms)`);
        return cb?.({
          ok: true,
          sessionId,
          engine: existing.engine,
          cwd: existing.cwd,
          // Answer with the session's engine — the catalog must describe what is running.
          ...await doorSession(existing, existing.engine)
        });
      }
      // A create in flight owns this id — wait for it rather than spawn a second CLI.
      if (creating.has(sessionId)) {
        const { session, done } = creating.get(sessionId);
        logger.info(`[ai] create → waiting on in-flight create`);
        await done;
        logger.info(`[ai] create → in-flight create done (${Date.now() - recvAt}ms)`);
        return cb?.({
          ok: true,
          sessionId,
          engine: session.engine,
          cwd: session.cwd,
          ...await doorSession(session)
        });
      }
      logger.info(`[ai] create session: ${sessionId} engine: ${engine} cwd: ${cwd}`);
      // Bind to a terminal's existing CLI conversation — the host knows which chat each terminal runs.
      const conv = getConversation(sessionId);
      const resumeId = options.cliSessionId || (engineFromAgent(conv?.agent) === engine ? conv.id : null);
      // Model defaults resolve host-side; adapters never read the machine's config.
      const spawnOptions = {
        ...(resumeId ? { ...options, cliSessionId: resumeId } : options),
        defaultModel: defaultModelFor(engine),
        defaultEffort: defaultEffortFor(engine) || options.defaultEffort
      };
      const session = manager.createSession(sessionId, engine, cwd, { ...spawnOptions, mock });
      let releaseCreate;
      creating.set(sessionId, { session, done: new Promise((r) => { releaseCreate = r; }) });
      try {
        await session.ready;
        logger.info(`[ai] create → spawned, ready in ${Date.now() - recvAt}ms`);
      } finally {
        creating.delete(sessionId);
        releaseCreate();
      }
      cb?.({
        ok: true,
        sessionId: session.id,
        engine: session.engine,
        cwd: session.cwd,
        ...await doorSession(session)
      });
    } catch (err) {
      logger.error(`[ai] create failed after ${Date.now() - recvAt}ms: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PROMPT, async ({ sessionId, message, cwd, attachments }, cb) => {
    try {
      let session = manager.getSession(sessionId);
      if (!session) {
        logger.warn(`[ai] session ${sessionId} not found on prompt, auto-creating with claude`);
        // A create in flight owns this id — wait rather than race a second CLI.
        if (creating.has(sessionId)) {
          await creating.get(sessionId).done;
          session = manager.getSession(sessionId);
        }
        if (!session) {
          // cwd rides along so the raced session lands in the right directory, not $HOME
          session = manager.createSession(sessionId, "claude", liveTerminalCwd(sessionId) || cwd || process.cwd(), {
            defaultModel: defaultModelFor("claude"),
            defaultEffort: defaultEffortFor("claude")
          });
          await session.ready;
        }
      }
      if (!session) throw new Error(`AI session unavailable: ${sessionId}`);
      logger.info(`[ai] prompt: ${sessionId} (engine: ${session.engine}): ${message?.slice(0, 60)}`);
      // The pane has already dropped its log; a refused /clear would strand an empty chat — stop the turn instead.
      if (String(message).trim() === "/clear" && session.isTurnRunning) session.stop();
      const res = session.sendPrompt(message, attachments);
      cb?.({ ok: true, queued: Boolean(res?.queued) });
    } catch (err) {
      logger.error(`[ai] prompt failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.QUEUE_REMOVE, ({ sessionId, id }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      const removed = session.removeQueueItem?.(id);
      cb?.({ ok: true, removed: Boolean(removed) });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.QUEUE_CLEAR, ({ sessionId }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      session.clearQueue?.();
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PERMISSION, async ({ sessionId, requestId, behavior, message }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      if (!session.resolvePermission(requestId, behavior, message)) {
        // Saying stale beats silent ok — the client would drop its card over an answer that reached nobody.
        return cb?.({ ok: false, reason: "stale" });
      }
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
      if (!session.resolveQuestion(requestId, answers)) {
        return cb?.({ ok: false, reason: "stale" });
      }
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
        const stopped = session.stop();
        // Backstop for a stop that never reaches a `stopped` event.
        broadcastAiStatus?.(sessionId, "idle", session.engine);
      }
      cb?.({ ok: true });
    } catch (err) {
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.STOP_TASK, async ({ sessionId, taskId }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) throw new Error(`AI session not found: ${sessionId}`);
      // Saying unsupported beats ok over a request that reached nobody.
      if (!session.stopTask(taskId)) return cb?.({ ok: false, reason: "unsupported" });
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] stopTask failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.PEEK_SEQ, ({ sessionId } = {}, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (!session) return cb?.({ ok: false, error: "not_found" });
      cb?.({
        ok: true,
        seq: session.history.at(-1)?.seq ?? 0,
        isTurnRunning: Boolean(session.isTurnRunning),
        queueLength: session.promptQueue?.length || 0
      });
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

  socket.on(AI_SOCKET_EVENTS.RESTART, async ({ sessionId }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      if (session) {
        await session.restart();
        broadcastAiStatus?.(sessionId, "idle", session.engine);
      }
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] restart failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });

  socket.on(AI_SOCKET_EVENTS.FILES, ({ workspace, query, limit = 25 }, cb) => {
    try {
      const files = searchRepoFiles(workspace, query, limit);
      cb?.({ ok: true, files });
    } catch (err) {
      cb?.({ ok: false, error: err.message, files: [] });
    }
  });

  // Static doctor spec, no session — constructing one would spawn a CLI to read a command name.
  socket.on(AI_SOCKET_EVENTS.DOCTOR, async ({ sessionId, engine = "claude", cwd }, cb) => {
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

  socket.on(AI_SOCKET_EVENTS.REWIND, async ({ sessionId, action = "list", messageId, index, files = true }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      const engine = session?.engine || "claude";
      const support = rewindSupport(engine);
      if (!support.conversation) {
        return cb?.({ ok: false, error: unsupportedReason(engine), support });
      }
      // Turn sources: claude's transcript on disk, codex's app-server, opencode's SQLite.
      const isClaude = engine === AI_ENGINES.CLAUDE;
      const isCodex = engine === AI_ENGINES.CODEX;
      // Codex answers from the live thread; an unbound chat is just an empty list.
      if (isCodex) {
        const points = await codexRewind.listRewindPoints(session).catch(() => []);
        return rewindForCodex({ cb, session, support, points, action, messageId, index });
      }
      // omp branches its own session tree over the live RPC — no store to prove ids against.
      if (engine === AI_ENGINES.OMP) {
        const adapter = session?.adapter;
        if (action === "list") {
          const points = await adapter?.branchPoints?.().catch(() => []) || [];
          return cb?.({
            ok: points.length > 0,
            support,
            points,
            ...(points.length > 0 ? {} : { error: "This conversation has no turn to rewind to yet." })
          });
        }
        if (action === "preview") {
          return cb?.({ ok: true, support, files: [], filesUnknown: false, note: CONVERSATION_ONLY_NOTE });
        }
        if (action === "apply") {
          if (session.isTurnRunning) return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
          const points = await adapter?.branchPoints?.().catch(() => []) || [];
          const target = messageId || points[index]?.messageId;
          const done = await adapter?.rewindConversation?.(target);
          if (!done?.rewound) return cb?.({ ok: false, error: done?.error || "The CLI did not rewind this conversation.", support });
          session.reloadFromStore?.();
          session.turnStartedAt = 0;
          session.lastTurnMs = 0;
          return cb?.({ ok: true, support, conversation: true });
        }
      }
      // Prove the id: opencode's DB on one side, claude's transcript (with the uuids) on the other.
      const convId = isClaude
        ? (claudeRewind.findTranscript(session?.cliSessionId) ? session.cliSessionId : null)
        : rewindable(engine, session?.cliSessionId);
      if (!convId) {
        // Not readable yet; `support` travels so the client can tell "wait" from "never".
        return cb?.({
          ok: false,
          error: `This conversation is not one ${engine} can rewind.`,
          support,
          points: []
        });
      }
      const list = isClaude ? claudeRewind.listRewindPoints : listRewindPoints;
      if (action === "list") {
        const points = list(convId);
        // ok must mean "there is a turn to go back to", not "request understood".
        return cb?.({
          ok: points.length > 0,
          support,
          points,
          ...(points.length > 0 ? {} : { error: "This conversation has no turn to rewind to yet." })
        });
      }
      // The client knows positions, not CLI ids — resolve against a fresh read.
      const targets = list(convId);
      const target = messageId || resolveRewindTarget(targets, index);
      // Session id in the log: concurrent chats otherwise make this read as another session's no-op.
      logger.debug(`[ai] rewind ${action}: session=${sessionId} ${engine} points=${targets.length} index=${index ?? "-"} → ${target || "UNRESOLVED"}`);
      if (!target) {
        // The client's count and the CLI's store disagree — name the fix, not the protocol.
        return cb?.({
          ok: false,
          error: "That turn is no longer in this conversation. Reload the chat and try again.",
          support
        });
      }
      if (action === "preview") {
        // The engine's own answer: claude runs rewind_files dry_run, opencode stages and clears.
        if (isClaude) return cb?.({ ok: true, support, ...(await claudePreview(session, target, { files })) });
        return cb?.({ ok: true, support, ...(await previewRewind(convId, target, { files })) });
      }
      if (action === "apply") {
        // A running turn is outside every checkpoint; the CLI's interrupt_if_running backstops this.
        if (session.isTurnRunning) {
          return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
        }
        // Claude cuts via control requests to the owning process; opencode commits through its server.
        const result = isClaude
          ? await claudeApply(session, targets, target, { files })
          : await applyRewind(convId, target, { files });
        if (!result.ok) return cb?.({ ok: false, error: result.error, support });
        // The CLI answers before flushing the new last-prompt (~50ms) — result.leaf, not the file, picks the branch.
        const rebuilt = session.reloadFromStore?.(result.leaf || null);
        logger.debug(`[ai] rewind applied: session=${sessionId} target=${target} leaf=${result.leaf || "-"} rebuiltLog=${rebuilt}`);
        if (!rebuilt) logger.warn(`[ai] rewind applied but the log did not rebuild: session=${sessionId}`);
        // The old span would describe turns the user just discarded.
        session.turnStartedAt = 0;
        session.lastTurnMs = 0;
        return cb?.({ ok: true, support, ...result });
      }
      cb?.({ ok: false, error: `Unknown rewind action: ${action}`, support });
    } catch (err) {
      logger.error(`[ai] rewind failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });
}
