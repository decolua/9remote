// AI Socket.IO protocol handler for 9remote
import { AI_SOCKET_EVENTS } from "./constants.js";
import { globalAiManager } from "./aiManager.js";
import { broadcast } from "../../transport/broadcast.js";
import { createLogger } from "../../lib/logger.js";
import { listSkills } from "./skills.js";
import { listMcpServers } from "./mcp.js";
import { searchRepoFiles } from "./files.js";
import { listModelOptions, listCodexModelOptions, listOpencodeModelOptions, resolveDefaultModel, resolveDefaultEffort } from "./models.js";
import { runEngineDoctor } from "./aiSession.js";
import { EVENT_TO_STATE, restatesOverGate } from "./aiStatus.js";
import { broadcastAiStatus } from "../terminal/terminalSocket.js";
import { getConversation, getSessionAgent, setConversationId, getStatus, touchWorking } from "../terminal/statusManager.js";
import { engineFromAgent } from "../terminal/conversationModes.js";
import { SESSION_ID_RE } from "../terminal/agentCatalog.js";
import { replayWindow } from "./aiEventSlice.js";
import { AI_REPLAY_BYTES, AI_ENGINES, AI_MODEL_CACHE_TTL_MS } from "./constants.js";
import { rewindSupport, unsupportedReason, resolveRewindTarget } from "./rewind.js";
import { listRewindPoints, rewindable, previewRewind, applyRewind } from "./opencodeRewind.js";
import * as claudeRewind from "./claudeRewind.js";
import * as codexRewind from "./codexRewind.js";

const logger = createLogger("ai");

// What the CLI calls a refusal, in words a reader can act on. It refuses rather than
// cutting when the turn to rewind is not one it can place — either the client's count has
// drifted from its own store, or it knows of a turn the client has not seen. Both are
// "reload and try again", and neither is the client's protocol described back at them.
const REWIND_REFUSALS = {
  stale_target: "That turn is no longer in this conversation. Reload the chat and try again.",
  unseen_later_turn: "This chat has turns newer than the one being rewound. Reload and try again."
};

const CONVERSATION_ONLY_NOTE = "No file changes to restore — this rewinds the conversation only.";

/**
 * The whole rewind conversation for codex, in one place.
 *
 * Split out rather than threaded through the shared handler because its shape is
 * different: the turns are read from the live thread (there is no id to prove, no
 * transcript to cut), the file half does not exist, and the reload after the cut is what
 * makes the change visible. Keeping it beside the handler's other branches was a nest of
 * `isClaude`/`isCodex` tests for what is really three separate protocols.
 */
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
    // The turn in flight is not part of the history being cut, so rewinding under it
    // strands it — refused here for the same reason the other engines refuse.
    if (session.isTurnRunning) {
      return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
    }
    const result = await codexRewind.applyRewind(session, target);
    if (!result.ok) return cb?.({ ok: false, error: result.error, support });
    // The thread is now the shortened one. Rebuild the log from the CLI's own store and
    // broadcast a reset, or every client keeps rendering the turns that were discarded.
    session.reloadFromStore?.();
    session.turnStartedAt = 0;
    session.lastTurnMs = 0;
    return cb?.({ ok: true, support, ...result });
  }
  cb?.({ ok: false, error: `Unknown rewind action: ${action}`, support });
}

/**
 * The file half, previewed: what this rewind WOULD restore, asked of the CLI itself.
 *
 * `target` is the first turn that goes, and `rewind_files` undoes the writes made from a
 * turn onward — inclusive — so the same uuid answers both halves of one rewind. Measured
 * against the CLI: a turn that created a file, rewound to itself, leaves the file gone.
 */
async function claudePreview(session, target, { files = true } = {}) {
  // Asked for no reason when the caller asked for a conversation-only rewind: the answer
  // is not shown, and the CLI would spend a checkpoint walk on it.
  if (!files) {
    return { ok: true, messageId: target, files: [], filesUnknown: false, note: CONVERSATION_ONLY_NOTE };
  }
  const res = await session.adapter?.rewindFiles?.(target, { dryRun: true });
  if (!res) return { ok: false, error: "The CLI did not answer.", messageId: target };
  // A failure must not read as "nothing changes": the confirm dialog would invite a
  // press on the strength of an answer that never came.
  if (res.error) return { ok: false, error: res.error, messageId: target };
  // The CLI saying it cannot rewind files for this session at all. Why is its business —
  // the observable is that no checkpoint exists here, and "nothing changes" would read as
  // a fact about THIS rewind rather than about the session.
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

/**
 * Both halves, as control requests to the process that already owns the conversation.
 *
 * No stop, no rewrite, no respawn: the CLI cuts its own memory and checkpoints its own
 * files, so there is no second writer of the transcript and no race to lose.
 */
async function claudeApply(session, targets, target, { files = true } = {}) {
  const adapter = session.adapter;
  if (!adapter?.rewindConversation) return { ok: false, error: "This chat has no CLI to rewind.", messageId: target };
  // The newest turn the caller has seen. The CLI refuses when its own store holds a later
  // one, which is precisely the case where cutting would discard a turn nobody rendered.
  const lastSeen = targets[targets.length - 1]?.messageId || target;
  // The CUT goes first, so a refusal costs nothing: the CLI turns this down for reasons
  // that are about the conversation, and doing the files first would leave them rewound
  // around a conversation that still has the turns — a half-state nobody asked for. Both
  // orders were measured to restore files just as well (spike-adapterRewind phase 5), so
  // this one is chosen for what it does when it fails, not for what it does when it works.
  const cut = await adapter.rewindConversation(target, lastSeen);
  if (!cut?.rewound) {
    // The refusal itself, in the log: without it a rejected rewind is indistinguishable
    // from one that never ran — the client reverts its log either way, so the screen shows
    // nothing in both cases.
    logger.debug(`[ai] rewind refused: target=${target} lastSeen=${lastSeen} reason=${cut?.reason || "-"} error=${cut?.error || "-"}`);
    return {
      ok: false,
      messageId: target,
      error: REWIND_REFUSALS[cut?.reason] || cut?.error || "The CLI did not rewind this conversation."
    };
  }
  // Then the files, which is a separate request and can still fail on its own. The
  // conversation HAS been rewound by now, so this does not turn the whole rewind into a
  // failure: the client reverts its own log on `ok: false`, and it would then be showing
  // turns the CLI has already dropped. Reported as what it is instead.
  if (files) {
    const done = await adapter.rewindFiles(target);
    if (done?.error) {
      logger.warn(`[ai] rewind: conversation cut, files not restored: ${done.error}`);
      return { ok: true, messageId: target, filesUnknown: true, prefillText: cut.prefillText || "", conversation: true, leaf: cut.precedingAssistantUuid || null };
    }
  }
  // `prefillText` is the text of the turn that went, from the CLI itself rather than a
  // copy this host made. The client re-sends its own edited text today (the edit button
  // replaces the turn, so that text is the newer one); this is what a caller with no text
  // of its own — the rewind modal — would put back in the composer.
  return { ok: true, messageId: target, prefillText: cut.prefillText || "", conversation: true, leaf: cut.precedingAssistantUuid || null };
}
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
// The table owns which event means what; an event it does not name says nothing.
function mirrorAiStatus(manager, sessionId, event, data, engine) {
  // A chat session has no PTY, so nothing else pushes the working TTL out — and
  // `done`/`blocked` are not the only things a turn says. Every event that arrives
  // while the CLI is alive is a sign of life, including the ones that name no state
  // (delta, tool_result, stats). Without this the reaper blanks a turn still running.
  // A replayed event is that sign too — history proves the CLI got this far.
  touchWorking(sessionId);
  // The dot says what the session is doing NOW. A log being re-sent is full of old
  // endings, and a rebuilt one always ends on a turn_complete: mirrored, that painted a
  // live turn as finished on every F5, until the next live event moved it back.
  if (data?.replay) return;
  const state = EVENT_TO_STATE[event];
  if (!state) return;
  const gateHeld = manager.getSession(sessionId)?.pendingPermission?.();
  if (restatesOverGate(event, getStatus(sessionId)?.state, gateHeld)) return;
  broadcastAiStatus?.(sessionId, state, engine, data);
}

// Model ids the host's own CLI offers, per engine. Null means the engine's registry
// list is authoritative (antigravity ships its own catalog).
// What a hydrating client gets: the tail of the log, not the whole thing. A real chat
// measured 6.9 MB of events, and shipping that on every mount is what stalls a phone.
// `hasMore` is what arms the client's scroll-up fetch, so it must travel with the tail.
//
// What every hydrate ack is made of, in the ONE order that works. Three doors answer a
// create (a live session, a create already in flight, a fresh spawn) and all three built
// their reply by spreading emitConnectMetadata and calling publicSession side by side —
// two expressions whose evaluation order is invisible at the call site, which is how the
// two got swapped.
//
//   1. rebuild first, from the CLI's own transcript — it is the authority on what the
//      conversation is, and this session's log is a cache of it that loses content. A
//      window measured before the rebuild hides the restored turns from scroll-up for
//      good (the ack's `fromSeq` is where the client's paging begins);
//   2. then the connect metadata, appended into the log that survived step 1. Reversed,
//      a fresh `init` lands in the log the rebuild replaces, and the ack goes out with no
//      model catalog and no skills on a chat that was just restored.
function doorSession(session, engine = session.engine) {
  session.refreshFromStore();
  return { ...emitConnectMetadata(session, engine), session: publicSession(session) };
}

// The session's replay window and the state a client cannot rebuild from it. Call it
// through doorSession, not on its own — the rebuild above has to have happened already.
export function publicSession(session) {
  const { events, hasMore } = replayWindow(session.history, AI_REPLAY_BYTES);
  return {
    events,
    hasMore,
    isTurnRunning: session.isTurnRunning,
    // How long the live turn has been going, and how long the last one took — both
    // durations on the host's clock, so a pane that loads mid-turn counts from the real
    // start instead of its own join, and prints a finished turn's span after an F5.
    elapsedMs: session.turnState().elapsedMs,
    lastTurnMs: session.lastTurnMs || null,
    // The newest seq, NOT the array length: past AI_MAX_EVENTS the log sheds its head,
    // so length stops equalling the highest seq and the client would swallow an event.
    seq: session.history.at(-1)?.seq ?? 0,
    permissionMode: session.permissionMode,
    // The harness's task records, outside the replay window's reach — a task announced
    // early in a long turn falls outside a 32KB tail, which is how an F5 came back with
    // an empty agent strip while a background shell was still going. Same reason as the
    // gate just below, and the same channel.
    taskRecords: session.taskRecords(),
    // The gate the CLI is holding, outside the replay window's reach — see
    // aiSession.pendingPermission for why the tail cannot be trusted to carry it.
    activePermission: session.pendingPermission?.() || null,
    model: session.model,
    // The session's own pick, snapshot-restored. Empty means "the CLI's config decides",
    // which the init event states — this only overrides it once the user has chosen.
    effort: session.effort || "",
    // Usage the replay cannot reconstruct: the adapter's counters are what the status
    // bar reads, and a log holds only the events, not the running totals. Without this
    // a fresh load showed an empty context row while the CLI held tens of thousands.
    stats: session.adapter?.stats || null
  };
}

function listModelOptionsFor(engine) {
  if (engine === "claude") return listModelOptions();
  if (engine === "codex") return listCodexModelOptions();
  if (engine === "opencode") return listOpencodeModelOptions();
  return null;
}

// Connect metadata is rebuilt on every create; the catalog is not. Two of the three
// engines answer by spawning a CLI, so re-reading it per F5 costs seconds of the ack.
const modelCache = new Map();

function cachedModelOptionsFor(engine) {
  const hit = modelCache.get(engine);
  const now = Date.now();
  if (hit && now - hit.at < AI_MODEL_CACHE_TTL_MS) return hit.options;
  const options = listModelOptionsFor(engine);
  modelCache.set(engine, { at: now, options });
  return options;
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

// Connect-time metadata: skills, MCP servers, the host's own model catalog, and the
// model/effort the CLI would run with. Every create answers with it — a LIVE session
// included, since its replay log holds only the CLI's own init, which carries no
// modelOptions: the pane would fall back to the registry's canned list on every F5.
function emitConnectMetadata(session, engine) {
  const skills = listSkills(engine, session.cwd);
  const mcpServers = listMcpServers(engine);
  // Kept on the session so a Clear can re-seed the log with the same metadata
  session.skills = skills;
  // Already-hydrated sessions skip the append: this runs on every connect (F5, extra
  // tab), and a log that grew an `init` per connect would never stop growing. The event
  // is still broadcast so the joining client sees the current metadata.
  session.emitNormalized("init", {
    skills,
    mcpServers,
    modelOptions: cachedModelOptionsFor(engine),
    model: session.model || defaultModelFor(engine),
    // The session's own pick wins; otherwise the CLI's config is what it will run
    // with, and that is what the composer must show beside the model.
    effort: session.effort || defaultEffortFor(engine)
  }, !session.hasRecordedInit());
  return { skills, mcpServers };
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
    manager.onEvent((sessionId, event, data, seq) => {
      // Streaming events fire per chunk — logging them drowns the file.
      if (event !== "delta" && event !== "thinking") logger.debug(`[ai] event: ${event} session: ${sessionId}`);
      // Failures the pane now draws are also worth a line here: the CLI's reason is one
      // sentence, and without it a reported "it errored" cannot be traced to which error.
      if (event === "exit" && (data?.error || (data?.code != null && data.code !== 0))) {
        logger.warn(`[ai] exit: session=${sessionId} engine=${manager.getSession(sessionId)?.engine || "claude"} code=${data.code ?? "-"} error=${data.error || "-"}`);
      }
      if (event === "turn_complete" && data?.isError) {
        logger.warn(`[ai] turn failed: session=${sessionId} subtype=${data.subtype || "-"} result=${String(data.result || "").slice(0, 300)}`);
      }
      // `seq` rides along so the client can tell an event it already replayed from a new
      // one — the same prompt arrives twice without it (live copy + replayed copy).
      broadcast(io, AI_SOCKET_EVENTS.EVENT, { sessionId, event, data, seq });
      const engine = manager.getSession(sessionId)?.engine || "claude";
      mirrorAiStatus(manager, sessionId, event, data, engine);
      mirrorAiConversation(sessionId, event, data, engine);
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
          engine: existing.engine,
          cwd: existing.cwd,
          // The session's own engine, not the request's: the two disagree only when a
          // client asks wrong, and the skills/catalog must describe what is running.
          ...doorSession(existing, existing.engine)
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
          engine: session.engine,
          cwd: session.cwd,
          ...doorSession(session)
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
      // Rebuild, then connect metadata, then the window — one order, one place (doorSession).
      cb?.({
        ok: true,
        sessionId: session.id,
        engine: session.engine,
        cwd: session.cwd,
        ...doorSession(session)
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
      if (!session.resolvePermission(requestId, behavior, message)) {
        // The CLI is not waiting for this id any more. Saying so beats the old silent
        // ok: the client would drop its card over an answer that reached nobody.
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
        session.stop();
        // The session emits `stopped`, which the table already calls idle — this is only
        // here for a stop that never reaches an event.
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
      // An engine with no per-task stop has nothing to answer, and saying so beats an ok
      // over a request that reached nobody — the client would settle its row on a lie.
      if (!session.stopTask(taskId)) return cb?.({ ok: false, reason: "unsupported" });
      cb?.({ ok: true });
    } catch (err) {
      logger.error(`[ai] stopTask failed: ${err.message}`);
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
  socket.on(AI_SOCKET_EVENTS.REWIND, async ({ sessionId, action = "list", messageId, index, files = true }, cb) => {
    try {
      const session = manager.getSession(sessionId);
      const engine = session?.engine || "claude";
      const support = rewindSupport(engine);
      if (!support.conversation) {
        return cb?.({ ok: false, error: unsupportedReason(engine), support });
      }
      // Where each engine's turns are readable from: claude's own transcript on disk,
      // codex's app-server (the same store `thread/revert` cuts), opencode's SQLite.
      const isClaude = engine === AI_ENGINES.CLAUDE;
      const isCodex = engine === AI_ENGINES.CODEX;
      // Codex answers from the live thread rather than from an id on disk, so there is
      // nothing to prove here — the thread either exists or `listRewindPoints` comes back
      // empty. Nothing bound yet (a chat that has run no turn) is that same empty answer.
      if (isCodex) {
        const points = await codexRewind.listRewindPoints(session).catch(() => []);
        return rewindForCodex({ cb, session, support, points, action, messageId, index });
      }
      // opencode's `rewindable` proves the id exists in its DB; Claude's proof is the
      // transcript file, which also carries the uuids the rewind flags take.
      const convId = isClaude
        ? (claudeRewind.findTranscript(session?.cliSessionId) ? session.cliSessionId : null)
        : rewindable(engine, session?.cliSessionId);
      if (!convId) {
        // The engine can rewind, but this conversation is not readable yet: a chat that
        // has run no turn has bound no id, and claude publishes its transcript only once
        // the turn starts. `support` still travels — that is what tells the client the
        // difference between "wait" and "never", and it asks again.
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
        // `ok` is what the pane shows the control on, so it has to mean "there is a turn
        // to go back to" — not merely "the request was understood". A conversation whose
        // first turn has not reached the CLI's own store yet has nothing to rewind to,
        // and answering ok there put an edit button on a bubble that could only fail.
        return cb?.({
          ok: points.length > 0,
          support,
          points,
          ...(points.length > 0 ? {} : { error: "This conversation has no turn to rewind to yet." })
        });
      }
      // The edit button on a bubble knows the turn's position, not its CLI id: the ids
      // the client renders are minted in its own store. Resolved against a fresh read
      // rather than a cached list, so a turn that arrived since is counted too.
      const targets = list(convId);
      const target = messageId || resolveRewindTarget(targets, index);
      // The session id is half of this line's meaning: several chats run at once, and
      // without it a rewind and the reset it broadcasts read as two different sessions,
      // which is exactly how "the host did nothing" was diagnosed wrongly from this log.
      logger.debug(`[ai] rewind ${action}: session=${sessionId} ${engine} points=${targets.length} index=${index ?? "-"} → ${target || "UNRESOLVED"}`);
      if (!target) {
        // The count the client holds and the CLI's own store disagree — its log was
        // rebuilt, or the turn sits outside what the CLI kept. Saying "missing message
        // id" described our protocol to the user; name what they can do about it.
        return cb?.({
          ok: false,
          error: "That turn is no longer in this conversation. Reload the chat and try again.",
          support
        });
      }
      if (action === "preview") {
        // The engine's own answer, not a reading of its transcript: for claude this is
        // `rewind_files` with `dry_run`, which knows what it would restore. opencode
        // stages the revert and clears it again — see opencodeRewind.previewRewind.
        if (isClaude) return cb?.({ ok: true, support, ...(await claudePreview(session, target, { files })) });
        return cb?.({ ok: true, support, ...(await previewRewind(convId, target, { files })) });
      }
      if (action === "apply") {
        // The turn in flight is not part of any checkpoint, so a rewind while one runs
        // strands it. Refused here as well as at the CLI (`interrupt_if_running` is the
        // backstop for a flag this host got wrong).
        if (session.isTurnRunning) {
          return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
        }
        // Claude's two halves are control requests to the process that already owns the
        // conversation: it cuts its own memory and checkpoints its own files, so nothing
        // here stops, rewrites or respawns. opencode stages and commits through its server.
        const result = isClaude
          ? await claudeApply(session, targets, target, { files })
          : await applyRewind(convId, target, { files });
        if (!result.ok) return cb?.({ ok: false, error: result.error, support });
        // The conversation is now the shortened one. Rebuild the host's log from the
        // transcript and broadcast a reset, or every client keeps rendering the turns the
        // rewind just discarded.
        // What the rebuild produced, next to what the CLI was asked for: a rewind that
        // succeeds and a log that comes back unchanged look identical from the pane, and
        // this is the line that tells them apart.
        // The CLI's own answer on where the branch now ends, handed to THIS rebuild.
        // Reading the file alone is not enough: the CLI answers `rewind_conversation`
        // before it flushes the new `last-prompt` (~50ms measured, spike-leafLag.mjs), so
        // a rebuild that reads straight away sees the pre-cut branch and hands the dropped
        // turns back — the pane grew the new turn while the old ones stayed until
        // something re-read the file later. The next reader (an F5, a hydrate) sees the
        // pointer written and comes out right, which is exactly how it was reported.
        const rebuilt = session.reloadFromStore?.(result.leaf || null);
        logger.debug(`[ai] rewind applied: session=${sessionId} target=${target} leaf=${result.leaf || "-"} rebuiltLog=${rebuilt}`);
        if (!rebuilt) logger.warn(`[ai] rewind applied but the log did not rebuild: session=${sessionId}`);
        // The span of the turn that produced the cut log describes turns the user just
        // discarded. Same reason as the resume path in aiSession.
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
