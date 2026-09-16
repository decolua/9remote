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
      // Claude reads its own transcript off disk; opencode goes through its server.
      const isClaude = engine === AI_ENGINES.CLAUDE;
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
      const preview = isClaude ? claudeRewind.previewRewind : previewRewind;
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
      logger.debug(`[ai] rewind ${action}: ${engine} points=${targets.length} index=${index ?? "-"} → ${target || "UNRESOLVED"}`);
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
        return cb?.({ ok: true, support, ...(await preview(convId, target, { files })) });
      }
      if (action === "apply") {
        // A rewind rewrites the conversation the CLI is holding. The running turn is
        // not part of any checkpoint, so applying mid-turn would strand it.
        if (session.isTurnRunning) {
          return cb?.({ ok: false, error: "Stop the running turn before rewinding.", support });
        }
        // TEMP DIAGNOSTIC — the confirm dialog stays open until this answers, so each
        // await here is time the user spends watching a frozen pane. Remove with the
        // rest of the rewind logging once the slow stage is known and dealt with.
        const t0 = Date.now();
        // A rewind cuts Claude's transcript in place, under the id it already has. The
        // running CLI is the only other writer of that file AND holds the discarded
        // turns in memory, so it is stood down before the rewrite and brought back
        // after — otherwise the old process could flush them back over the cut, and the
        // new one would answer from a conversation that no longer exists on disk.
        if (isClaude) await session.stopAdapter?.();
        const tStop = Date.now();
        // Claude's file half is a one-shot CLI run that needs the session's cwd.
        const result = isClaude
          ? await claudeRewind.applyRewind(convId, target, { files, cwd: session.cwd })
          : await applyRewind(convId, target, { files });
        const tCut = Date.now();
        // Bring it back whatever the outcome — a failed rewind must not leave the chat
        // with no process behind it, which is how "the rewind failed" would turn into
        // "the conversation is dead".
        if (isClaude) await session.startAdapter?.();
        const tStart = Date.now();
        if (!result.ok) return cb?.({ ok: false, error: result.error, support });
        // The CLI's store is now the shortened conversation. Rebuild the host's log from
        // it and broadcast a reset, or every client keeps rendering the turns the rewind
        // just discarded.
        session.reloadFromStore?.();
        // The conversation was cut, so the span of the turn that produced it describes
        // turns the user just discarded. Same reason as the resume path in aiSession.
        session.turnStartedAt = 0;
        session.lastTurnMs = 0;
        logger.debug(`[ai] rewind timing: stop=${tStop - t0} cut+files=${tCut - tStop} restart=${tStart - tCut}`);
        return cb?.({ ok: true, support, ...result });
      }
      cb?.({ ok: false, error: `Unknown rewind action: ${action}`, support });
    } catch (err) {
      logger.error(`[ai] rewind failed: ${err.message}`);
      cb?.({ ok: false, error: err.message });
    }
  });
}
