"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { parseEngineTaskEvent, parseEngineTaskResult } from "../registry";

const DEFAULT_STATS = { inputTokens: 0, outputTokens: 0, totalTurns: 0 };
const DEFAULT_METADATA = { model: "" };

// The CLI reports skills as bare id strings; the agent-side scan reports objects.
// Normalize both to one shape so the "/" menu and skills modal never render `undefined`.
const normalizeSkills = (skills) =>
  Array.isArray(skills)
    ? skills.map((s) => (typeof s === "string" ? { id: s, name: s, description: "" } : s))
    : [];
const EMPTY_MESSAGES = [];
// How long live events are held while waiting for the ai:create snapshot ack.
const HYDRATE_TIMEOUT_MS = 4000;
// An ack wait budget for the scroll-up fetch. A carrier that dies mid-flight never
// calls back, and the same guard is what keeps the terminal's history fetch alive
// (see features/terminal/lib/reconnectState.js).
const HISTORY_TIMEOUT_MS = 4000;

// Pure reducer that transforms an event log into a complete session snapshot in RAM
// in <3ms, avoiding thousands of re-renders and synchronous store dispatches.
export function reduceSessionEvents(events = [], engine = "claude", idBase = 0) {
  const messages = [];
  const tasks = [];
  let metadata = { model: "", skills: [], mcpServers: [] };
  let stats = { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 };
  let isTurnRunning = false;
  let activePermission = null;
  let activeBlocked = null;
  let permissionMode = null;
  let msgSeq = idBase;

  for (const item of events) {
    const event = item?.event;
    const data = item?.data;
    if (!event) continue;

    switch (event) {
      case "user_message": {
        isTurnRunning = true;
        // A new turn supersedes the previous refusal — same as the live path.
        activeBlocked = null;
        messages.push({ id: `u-${++msgSeq}`, role: "user", content: data?.text || "" });
        messages.push({
          id: `a-${++msgSeq}`,
          role: "assistant",
          content: "",
          thinking: "",
          diffs: [],
          tools: [],
          isLive: true
        });
        break;
      }
      case "init": {
        // Engines emit init more than once (skills first, then thread/model). A later
        // init that carries no skills must not wipe the ones already discovered.
        const incoming = normalizeSkills(data?.skills);
        const skills = incoming.length > 0 ? incoming : metadata.skills;
        metadata = { ...metadata, ...(data || {}), skills };
        break;
      }
      case "delta": {
        let last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") {
          last = { id: `msg-${++msgSeq}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
          messages.push(last);
        }
        last.content = (last.content || "") + (data?.text || "");
        break;
      }
      case "thinking": {
        let last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") {
          last = { id: `msg-${++msgSeq}`, role: "assistant", content: "", thinking: "", isLive: true, diffs: [], tools: [] };
          messages.push(last);
        }
        last.thinking = (last.thinking || "") + (data?.text || "");
        break;
      }
      case "diff": {
        if (!data) break;
        let last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") {
          last = { id: `msg-${++msgSeq}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
          messages.push(last);
        }
        const diffs = last.diffs || (last.diffs = []);
        const idx = diffs.findIndex((d) => d.file === data.file);
        if (idx !== -1) diffs[idx] = data;
        else diffs.push(data);
        break;
      }
      case "tool_start": {
        if (!data) break;
        let last = messages[messages.length - 1];
        if (last && last.role === "assistant" && last.isLive && ((last.content || last.thinking || "").length > 0)) {
          last.isLive = false;
          last = {
            id: `msg-${++msgSeq}`,
            role: "assistant",
            content: "",
            isLive: true,
            diffs: [],
            tools: [{ ...data, status: data.status || "running" }]
          };
          messages.push(last);
        } else if (!last || last.role !== "assistant") {
          last = {
            id: `msg-${++msgSeq}`,
            role: "assistant",
            content: "",
            isLive: true,
            diffs: [],
            tools: [{ ...data, status: data.status || "running" }]
          };
          messages.push(last);
        } else {
          const tools = last.tools || (last.tools = []);
          const idx = tools.findIndex((t) => t.id === data.id);
          if (idx !== -1) tools[idx] = { ...tools[idx], ...data };
          else tools.push({ ...data, status: data.status || "running" });
        }
        if (data.name) {
          const t = parseEngineTaskEvent(engine, data.name, data.input, data.id, tasks);
          if (t) {
            const tId = String(t.taskId || t.id || "");
            const tIdx = tasks.findIndex(
              (item, i) =>
                (item.id && String(item.id) === tId) ||
                (item.taskId && String(item.taskId) === tId) ||
                String(i + 1) === tId
            );
            if (tIdx !== -1) tasks[tIdx] = { ...tasks[tIdx], ...t };
            else if (t.subject) tasks.push(t);
          }
        }
        break;
      }
      case "tool_result": {
        if (!data?.id) break;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const t = msg?.tools?.find((item) => item.id === data.id);
          if (t) {
            Object.assign(t, data, { status: data.status || "done" });
            break;
          }
        }
        const taskRes = parseEngineTaskResult(engine, data.name || "", data.output || "", data.id);
        if (taskRes) {
          const tId = String(taskRes.taskId || taskRes.id || "");
          const tIdx = tasks.findIndex(
            (item, i) =>
              (item.id && String(item.id) === tId) ||
              (item.taskId && String(item.taskId) === tId) ||
              String(i + 1) === tId
          );
          if (tIdx !== -1) tasks[tIdx] = { ...tasks[tIdx], ...taskRes };
        }
        break;
      }
      case "permission_request":
        activePermission = data;
        break;
      case "permission_resolved":
        activePermission = null;
        break;
      case "blocked":
        // A CLI refusal (sandbox/permission) — carries a mode that would allow it.
        activeBlocked = data;
        break;
      case "options_changed":
        if (data?.permissionMode) permissionMode = data.permissionMode;
        if (data?.model) metadata.model = data.model;
        break;
      case "turn_complete":
        isTurnRunning = false;
        activePermission = null;
        if (data?.stats) stats = { ...stats, ...data.stats };
        if (messages.length > 0) messages[messages.length - 1].isLive = false;
        break;
      case "stats":
        if (data?.stats) stats = { ...stats, ...data.stats };
        break;
      case "stopped":
        isTurnRunning = false;
        break;
      case "exit":
        // The CLI process went away. Turn ends either way — without this the pane
        // kept spinning on a process that was already gone (only claudeAdapter emits it).
        isTurnRunning = false;
        break;
      case "error":
        // An error can land mid-turn (opencode reports a blocked action this way), so the
        // segment still streaming must be closed — otherwise its bubble keeps a live
        // spinner even though the turn is over.
        isTurnRunning = false;
        for (const m of messages) if (m.isLive) m.isLive = false;
        messages.push({
          id: `msg-${++msgSeq}`,
          role: "assistant",
          content: `\n\n**Error:** ${data?.message || "AI process failed"}`,
          isLive: false,
          diffs: [],
          tools: []
        });
        break;
      case "conversation_reset":
        messages.length = 0;
        tasks.length = 0;
        isTurnRunning = false;
        activePermission = null;
        activeBlocked = null;
        break;
      default:
        break;
    }
  }

  return { messages, tasks, metadata, stats, isTurnRunning, activePermission, activeBlocked, permissionMode };
}

export function useAiSession({
  sessionId,
  engine = "claude",
  workspacePath = "",
  bus = null
}) {
  const busRef = useRef(bus);
  useEffect(() => {
    busRef.current = bus;
  }, [bus]);

  const initSession = useAiStore((s) => s.initSession);
  const setMetadata = useAiStore((s) => s.setMetadata);
  const appendDelta = useAiStore((s) => s.appendDelta);
  const appendThinking = useAiStore((s) => s.appendThinking);
  const appendDiff = useAiStore((s) => s.appendDiff);
  const appendTool = useAiStore((s) => s.appendTool);
  const updateToolResult = useAiStore((s) => s.updateToolResult);
  const upsertTask = useAiStore((s) => s.upsertTask);
  const setPermission = useAiStore((s) => s.setPermission);
  const clearPermission = useAiStore((s) => s.clearPermission);
  const finishTurn = useAiStore((s) => s.finishTurn);
  const setTurnRunning = useAiStore((s) => s.setTurnRunning);
  const addUserMessage = useAiStore((s) => s.addUserMessage);

  // Host events older than the replayed tail, still unfetched. The pane pages the
  // in-RAM window first; only when it runs out does a scroll-up hit the host.
  const [hasOlder, setHasOlder] = useState(false);
  const olderSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);

  // Read session-specific state from Zustand
  const sessionState = useAiStore((s) => s.bySession[sessionId]);
  const messages = sessionState?.messages || EMPTY_MESSAGES;
  const isTurnRunning = sessionState?.isTurnRunning || false;
  const stats = sessionState?.stats || DEFAULT_STATS;
  const metadata = sessionState?.metadata || DEFAULT_METADATA;
  const activeBlocked = sessionState?.activeBlocked || null;

  // One reducer for BOTH live events and join-replay — the host (daemon) is the
  // single source of truth, so replayed history must land in the same store
  // actions a live event would.
  const applyEvent = useCallback((sid, event, data) => {
    switch (event) {
      case "user_message":
        addUserMessage(sid, data.text);
        break;
      case "init": {
        // The agent-side scan (with descriptions) and the CLI's init both land here.
        // Keep the richer entry when the CLI's bare id arrives second.
        // Current may still hold raw strings from state persisted before this normalization
        const current = normalizeSkills(useAiStore.getState().bySession[sid]?.metadata?.skills);
        const byId = new Map(current.map((s) => [s.id || s.name, s]));
        const incoming = normalizeSkills(data.skills);
        // A later init (thread/model) carries no skills — don't wipe what we have
        const skills = incoming.length > 0
          ? incoming.map((s) => {
              const known = byId.get(s.id);
              return known?.description ? { ...s, description: known.description } : s;
            })
          : current;
        setMetadata(sid, { ...data, skills });
        break;
      }
      case "delta":
        appendDelta(sid, data.text);
        break;
      case "thinking":
        appendThinking(sid, data.text);
        break;
      case "diff":
        appendDiff(sid, data);
        break;
      case "tool_start":
        appendTool(sid, data);
        if (data && data.name) {
          const currentTasks = useAiStore.getState().bySession[sid]?.tasks || [];
          const task = parseEngineTaskEvent(engine, data.name, data.input, data.id, currentTasks);
          if (task) {
            upsertTask(sid, task);
          }
        }
        break;
      case "tool_result":
        updateToolResult(sid, data);
        if (data && data.id) {
          const taskRes = parseEngineTaskResult(engine, data.name || "", data.output || "", data.id);
          if (taskRes) {
            upsertTask(sid, taskRes);
          }
        }
        break;
      case "permission_request":
        setPermission(sid, data);
        break;
      case "permission_resolved":
        // Another surface (or a replay) closed this gate — drop the card here too
        clearPermission(sid, data.requestId);
        break;
      case "blocked":
        useAiStore.getState().setBlocked(sid, data);
        break;
      case "options_changed":
        // Another surface switched mode/model — this one shows the same thing
        if (data?.permissionMode) useAiStore.getState().setPermissionMode(sid, data.permissionMode);
        if (data?.model) setMetadata(sid, { model: data.model });
        break;
      case "turn_complete":
        finishTurn(sid, data.stats);
        break;
      case "stats":
        // codex/opencode report token usage mid-turn; claude folds it into turn_complete
        if (data?.stats) useAiStore.getState().setStats(sid, data.stats);
        break;
      case "stopped":
        setTurnRunning(sid, false);
        break;
      case "error":
        // Spawn/CLI failure never produces a turn_complete — surface it as text
        // and release the turn, or the pane spins on a process that is gone.
        appendDelta(sid, `\n\n**Error:** ${data?.message || "AI process failed"}`);
        finishTurn(sid);
        break;
      case "conversation_reset":
        useAiStore.getState().clearMessages(sid);
        break;
      default:
        break;
    }
  }, [engine, addUserMessage, setMetadata, appendDelta, appendThinking, appendDiff, appendTool, updateToolResult, upsertTask, setPermission, clearPermission, finishTurn, setTurnRunning]);

  // applyEvent changes identity whenever its store actions do; the hydrate effect
  // below must NOT re-run for that — re-emitting ai:create would truncate and
  // replay over a session that is mid-stream.
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; });

  // Highest host seq this client has applied. Events at or below it are already
  // folded in (replayed or live) and must not be applied twice.
  const appliedSeqRef = useRef(0);
  // Live events that arrive between emitting ai:create and its ack. The ack
  // resets the store and replays the snapshot, so anything applied in that window
  // would be wiped — hold them and re-apply after the replay, in order. This is
  // the AI counterpart of the terminal's "replay before live output" ordering.
  const hydratingRef = useRef(false);
  const pendingLiveRef = useRef([]);
  // Bumped per hydrate attempt. StrictMode mounts twice and the first ack must not
  // release the gate the second attempt is still holding — a stale callback stands
  // down instead of clearing state a newer cycle owns.
  const hydrateSeqRef = useRef(0);

  // 1. Initialize session in store and on host agent. The ack carries the host's
  // full event log — the host is authoritative, so a client rebuilds its view
  // from it (truncate then replay) rather than trusting its own localStorage.
  // That is what makes web 3000 / agent UI / mobile show one identical history.
  useEffect(() => {
    if (!sessionId) return;
    initSession(sessionId);
    if (!bus) return;
    const gen = ++hydrateSeqRef.current;
    hydratingRef.current = true;
    pendingLiveRef.current = [];
    olderSeqRef.current = 0;
    // Drains the held events in arrival order, skipping any the snapshot covers.
    const releaseHeld = () => {
      const queued = pendingLiveRef.current;
      pendingLiveRef.current = [];
      hydratingRef.current = false;
      for (const p of queued) {
        // A reset restarts the host's log at seq 1 — the snapshot's watermark no
        // longer applies to what follows it.
        if (p.event === "conversation_reset") {
          appliedSeqRef.current = 0;
          olderSeqRef.current = p.data?.fromSeq ?? 0;
          setHasOlder(Boolean(p.data?.hasMore));
          applyEventRef.current(sessionId, p.event, p.data);
          continue;
        }
        if (p.seq != null) {
          if (p.seq <= appliedSeqRef.current) continue;
          appliedSeqRef.current = p.seq;
        }
        applyEventRef.current(sessionId, p.event, p.data);
      }
    };
    // A lost ack (carrier dropped mid-flight) must not leave the gate shut forever
    // — that would buffer every later live event and freeze the chat for good.
    // Past this window the snapshot is stale anyway and live events are newer.
    const releaseTimer = setTimeout(() => {
      if (gen !== hydrateSeqRef.current || !hydratingRef.current) return;
      releaseHeld();
    }, HYDRATE_TIMEOUT_MS);
    bus.emit("ai:create", { sessionId, engine, cwd: workspacePath }, (res) => {
      // A newer hydrate (StrictMode remount) owns the gate now — stand down.
      if (gen !== hydrateSeqRef.current) return;
      const events = res?.session?.events;
      try {
        clearTimeout(releaseTimer);
        // Both paths answer with a replayable log: the daemon sends its live session
        // state, the in-agent engines send `session.history`. An ack with no array is
        // the only case where there is nothing to replay.
        if (!res?.ok || !Array.isArray(events)) {
          setHasOlder(false);
          return;
        }
        const snapshotSeq = res.session.seq || 0;
        // The host replays only the tail of a long log; the rest is fetched on scroll-up.
        olderSeqRef.current = events[0]?.seq ?? 0;
        setHasOlder(Boolean(res.session.hasMore) && events.length > 0);
        // An empty host log means the host has nothing for this session yet (fresh
        // one, or a legacy session created before the daemon owned state). Leave
        // whatever the client already has instead of blanking it.
        if (events.length > 0) {
          // Pure in-memory reduction in <3ms instead of 5000+ synchronous store dispatches
          const hydrated = reduceSessionEvents(events, engine);
          useAiStore.getState().hydrateSession(sessionId, {
            messages: hydrated.messages,
            tasks: hydrated.tasks,
            // The host is the authority on spawn-time options: its snapshot carries
            // the effort the CLI actually runs with, which the replay may not.
            metadata: { ...hydrated.metadata, ...(res.session.effort ? { effort: res.session.effort } : {}) },
            stats: hydrated.stats,
            isTurnRunning: res.session.isTurnRunning !== undefined ? Boolean(res.session.isTurnRunning) : hydrated.isTurnRunning,
            permissionMode: res.session.permissionMode || hydrated.permissionMode,
            activeBlocked: hydrated.activeBlocked
          });
          if (hydrated.activePermission) {
            useAiStore.getState().setPermission(sessionId, hydrated.activePermission);
          }
        } else {
          setTurnRunning(sessionId, Boolean(res.session.isTurnRunning));
          if (res.session.permissionMode) {
            useAiStore.getState().setPermissionMode(sessionId, res.session.permissionMode);
          }
        }
        // The snapshot is authoritative for this log. Assign rather than max: after a
        // /resume or /clear the host starts a NEW log whose seqs begin at 1, so a
        // higher watermark left over from the previous log would drop every replay.
        appliedSeqRef.current = snapshotSeq;
      } finally {
        // Always drains — a failed ack must not discard events that really arrived.
        clearTimeout(releaseTimer);
        if (gen === hydrateSeqRef.current) releaseHeld();
      }
    });
    return () => clearTimeout(releaseTimer);
  }, [sessionId, engine, workspacePath, bus, initSession, setTurnRunning]);

  // 2. Subscribe to AI bus events
  useEffect(() => {
    if (!bus || !sessionId) return;

    const handleAiEvent = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      // Mid-hydrate: the store is about to be reset and replayed, so applying now
      // would be thrown away. Hold it; the ack drains this queue after the replay.
      if (hydratingRef.current) {
        pendingLiveRef.current.push(payload);
        return;
      }
      // A reset means the host is starting a NEW log whose seqs begin again at 1.
      // The old watermark would drop every replayed event as "already applied", so
      // it must be cleared before the replay that follows.
      if (payload.event === "conversation_reset") {
        appliedSeqRef.current = 0;
        // The window belongs to the log that just ended. Keeping it would make the next
        // scroll-up fetch seqs the fresh log already replays — every turn rendered twice.
        // The host replays a tail only, so the reset states where that tail starts.
        olderSeqRef.current = payload.data?.fromSeq ?? 0;
        setHasOlder(Boolean(payload.data?.hasMore));
        applyEvent(sessionId, payload.event, payload.data);
        return;
      }
      // Already covered by a replay this client hydrated from — applying it again
      // would duplicate the message. Unstamped (legacy in-agent) events pass.
      if (payload.seq != null) {
        if (payload.seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = payload.seq;
      }
      applyEvent(sessionId, payload.event, payload.data);
    };

    bus.on("ai:event", handleAiEvent);
    return () => {
      bus.off("ai:event", handleAiEvent);
    };
  }, [bus, sessionId, applyEvent]);

  // 3. User actions
  const sendPrompt = useCallback(
    (text, { force = false, attachments = null } = {}) => {
      if (!text && !attachments?.length) return;
      // Read the turn state live, not from this render's closure: the queue drain
      // calls us right after stop(), while the memoized closure still says running —
      // bailing on that stale flag silently dropped the queued prompt.
      // `force` is for host-side commands (/clear): they reset state on the host and
      // must work even mid-turn, unlike a prompt the CLI would have to queue.
      if (!force) {
        const running = useAiStore.getState().bySession[sessionId]?.isTurnRunning;
        if (running) return;
      }
      const b = busRef.current || useConnectionStore.getState().bus;
      // No ai:create here: the host auto-creates on prompt, and the mount effect
      // already hydrated this session. Re-emitting it per message would make the
      // host serialize and ship the entire event log back on every keystroke-send.
      // No optimistic user message either: the host echoes "user_message" to every
      // client (including us), which is what keeps surfaces in lockstep.
      // Staged images/files ride with the prompt: the host writes them where the CLI
      // can read them. `message` stays the user's own words so the echoed bubble is
      // the text they typed, not a path list.
      b?.emit("ai:prompt", {
        sessionId,
        message: text,
        cwd: workspacePath,
        ...(attachments?.length ? { attachments } : {})
      });
    },
    [sessionId, workspacePath]
  );

  const resolvePermission = useCallback(
    (requestId, behavior, message = "", answers = null) => {
      clearPermission(sessionId, requestId);
      const b = busRef.current || useConnectionStore.getState().bus;
      if (answers) {
        b?.emit("ai:question", { sessionId, requestId, answers });
      } else {
        b?.emit("ai:permission", { sessionId, requestId, behavior, message });
      }
    },
    [sessionId, clearPermission]
  );

  const stop = useCallback(() => {
    const b = busRef.current || useConnectionStore.getState().bus;
    b?.emit("ai:stop", { sessionId });
    setTurnRunning(sessionId, false);
  }, [sessionId, setTurnRunning]);

  const runShell = useCallback(
    (command) => {
      sendPrompt(`! ${command}`);
    },
    [sendPrompt]
  );

  const rewindToMessage = useCallback(
    (messageId, newText) => {
      // Truncate to message; optionally re-submit the edited text as a new prompt.
      // The host echoes "user_message" back, so no local optimistic add here.
      useAiStore.getState().rewindToMessage(sessionId, messageId, newText);
      if (newText) {
        const b = busRef.current || useConnectionStore.getState().bus;
        b?.emit("ai:prompt", { sessionId, message: newText, cwd: workspacePath });
      }
    },
    [sessionId, workspacePath]
  );

  // Escalate out of a blocked action: switch to the mode the card proposed and
  // clear the card. The host applies the mode to the CLI.
  const escalateMode = useCallback(
    (mode) => {
      if (!mode) return;
      useAiStore.getState().setPermissionMode(sessionId, mode);
      useAiStore.getState().clearBlocked(sessionId);
      const b = busRef.current || useConnectionStore.getState().bus;
      b?.emit("ai:options", { sessionId, options: { mode } });
    },
    [sessionId]
  );

  const dismissBlocked = useCallback(() => {
    useAiStore.getState().clearBlocked(sessionId);
  }, [sessionId]);

  // Older turns live on the host, not in RAM. Fetch the next chunk, then prepend the
  // messages it reduces to; the ids continue past the window already held so they
  // stay unique as React keys.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return false;
    const b = busRef.current || useConnectionStore.getState().bus;
    if (!b) return false;
    loadingOlderRef.current = true;
    // The log may be replaced while this is in flight (/resume, /clear). The chunk is
    // older events of a conversation that is no longer shown, so its ack stands down
    // instead of prepending one log's turns onto another's.
    const logSeq = olderSeqRef.current;
    try {
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
        b.emit("aiHistory", { sessionId, before: logSeq }, done);
      });
      if (olderSeqRef.current !== logSeq) return false;
      // A timed-out ack is not an answer — keep the door open so the next scroll retries.
      // Only the host saying "no such session" closes it.
      if (res == null) return false;
      if (!res.success || !res.events?.length) {
        setHasOlder(false);
        return false;
      }
      olderSeqRef.current = res.events[0].seq ?? olderSeqRef.current;
      setHasOlder(Boolean(res.hasMore));
      const curr = useAiStore.getState().bySession[sessionId];
      const older = reduceSessionEvents(res.events, engine, (curr?.messages?.length || 0) + 1);
      useAiStore.getState().prependMessages(sessionId, older.messages);
      return true;
    } finally {
      loadingOlderRef.current = false;
    }
  }, [sessionId, engine]);

  return {
    messages,
    isTurnRunning,
    stats,
    metadata,
    activeBlocked,
    hasOlder,
    loadOlder,
    sendPrompt,
    resolvePermission,
    stop,
    runShell,
    rewindToMessage,
    escalateMode,
    dismissBlocked
  };
}
