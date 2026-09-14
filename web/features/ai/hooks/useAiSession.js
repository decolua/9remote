"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { parseEngineTaskEvent, parseEngineTaskResult, getEngineConfig } from "../registry";
import { updateToolTree, settleRunningTools } from "../lib/toolTree";
import { createRetryLadder } from "../lib/hydrateRetry";
import { termLog } from "@/shared/utils/termLog";
import { RECOVER_DEBOUNCE_MS } from "@/features/terminal/constants/terminalConfig";

// The CLI reports skills as bare id strings; the agent-side scan reports objects.
// Normalize both to one shape so the "/" menu and skills modal never render `undefined`.
const normalizeSkills = (skills) =>
  Array.isArray(skills)
    ? skills.map((s) => (typeof s === "string" ? { id: s, name: s, description: "" } : s))
    : [];
// How long live events are held while waiting for the ai:create snapshot ack.
const HYDRATE_TIMEOUT_MS = 4000;
// An ack wait budget for the scroll-up fetch. A carrier that dies mid-flight never
// calls back, and the same guard is what keeps the terminal's history fetch alive
// (see features/terminal/lib/reconnectState.js).
const HISTORY_TIMEOUT_MS = 4000;
// A hydrate whose ack never arrived leaves the pane without the host's tail, and with
// it the load-older affordance. The ladder that re-asks lives in lib/hydrateRetry, and
// the lib owns the delays — this hook only drives its timer.

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
  let turnEnded = false;
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
        messages.push({ id: `u-${++msgSeq}`, role: "user", content: data?.text || "", attachments: data?.attachments || [] });
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
      case "goal":
        metadata = { ...metadata, goal: data?.goal || null };
        break;
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
      // A sub-agent's tool call: nested under the Agent/Task card that spawned it,
      // never a row of its own. Dropped when the parent is not in the log.
      case "tool_child": {
        if (!data) break;
        for (let i = messages.length - 1; i >= 0; i--) {
          const tools = updateToolTree(messages[i]?.tools, (t) => t.id === data.parentToolUseId, (parent) => {
            const children = [...(parent.children || [])];
            const idx = children.findIndex((c) => c.id === data.id);
            if (idx !== -1) children[idx] = { ...children[idx], ...data };
            else children.push({ ...data, status: data.status || "running" });
            return { ...parent, children };
          });
          if (!tools) continue;
          messages[i].tools = tools;
          break;
        }
        break;
      }
      case "tool_result_child": {
        if (!data?.id) break;
        for (let i = messages.length - 1; i >= 0; i--) {
          const tools = updateToolTree(
            messages[i]?.tools,
            (t) => (t.children || []).some((c) => c.id === data.id),
            (parent) => ({
              ...parent,
              children: parent.children.map((c) =>
                c.id === data.id ? { ...c, ...data, status: data.status || "done" } : c
              )
            })
          );
          if (!tools) continue;
          messages[i].tools = tools;
          break;
        }
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
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        if (data?.stats) stats = { ...stats, ...data.stats };
        if (messages.length > 0) messages[messages.length - 1].isLive = false;
        break;
      case "stats":
        if (data?.stats) stats = { ...stats, ...data.stats };
        break;
      case "stopped":
        turnEnded = true;
        isTurnRunning = false;
        break;
      case "stall":
        // The watchdog killed a silent turn. Ends the turn like `stopped`, but draws no
        // bubble: it fires on a timeout guess, so a slow build must not read as an error.
        turnEnded = true;
        isTurnRunning = false;
        for (const m of messages) if (m.isLive) m.isLive = false;
        break;
      case "exit":
        turnEnded = true;
        // The CLI process went away. Turn ends either way — without this the pane
        // kept spinning on a process that was already gone (only claudeAdapter emits it).
        isTurnRunning = false;
        break;
      case "error":
        turnEnded = true;
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

  // Nothing is still running once the turn is over. Settled here rather than in each of
  // the ending events so every one of them is covered. Keyed on having SEEN the end,
  // not on isTurnRunning: a page of older events is reduced on its own and carries no
  // end event, and its tools must stay as they are.
  if (turnEnded) {
    for (const m of messages) if (m.tools) m.tools = settleRunningTools(m.tools);
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
  const nestTool = useAiStore((s) => s.nestTool);
  const nestToolResult = useAiStore((s) => s.nestToolResult);
  const upsertTask = useAiStore((s) => s.upsertTask);
  const setPermission = useAiStore((s) => s.setPermission);
  const clearPermission = useAiStore((s) => s.clearPermission);
  const finishTurn = useAiStore((s) => s.finishTurn);
  const setTurnRunning = useAiStore((s) => s.setTurnRunning);
  const addUserMessage = useAiStore((s) => s.addUserMessage);

  // Host events older than the replayed tail, still unfetched. The pane pages the
  // in-RAM window first; only when it runs out does a scroll-up hit the host.
  const [hasOlder, setHasOlder] = useState(false);
  // Mirrors hydratingRef as state so the pane can say "Syncing" — a ref alone would
  // never repaint the status line.
  const [hydrating, setHydrating] = useState(false);
  // Whether the host has ever answered for this session. An empty store means "still
  // loading" until it has: a pane that shows its empty state on an unanswered hydrate is
  // telling the user the chat is new when the truth is that nobody has replied yet.
  // Reset per session, and only an ok ack sets it — a rejected one is not an answer.
  const [synced, setSynced] = useState(false);
  const olderSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);

  // This hook does not read the session slice: it only dispatches into it, and the
  // panes subscribe to what they need themselves. Subscribing here would rebuild the
  // whole hook body — and every callback and effect hanging off it — once per streamed
  // frame, which is the cost the delta buffering below exists to avoid.

  // One reducer for BOTH live events and join-replay — the host (daemon) is the
  // single source of truth, so replayed history must land in the same store
  // actions a live event would.
  const applyEvent = useCallback((sid, event, data) => {
    switch (event) {
      case "user_message":
        addUserMessage(sid, data.text, data.attachments || null);
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
      case "goal":
        // Codex's own persistent goal, read from its state DB by the host. A null goal
        // means "none set" and must clear the one already shown.
        setMetadata(sid, { goal: data?.goal || null });
        break;
      case "delta":
        appendDelta(sid, data.text);
        break;
      case "thinking":
        appendThinking(sid, data.text);
        break;
      case "diff":
        appendDiff(sid, data);
        break;
      case "tool_child":
        nestTool(sid, data);
        break;
      case "tool_result_child":
        nestToolResult(sid, data);
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
      case "stall":
        // Same release as `stopped`, deliberately without the text `error` appends.
        setTurnRunning(sid, false);
        finishTurn(sid);
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
  }, [engine, addUserMessage, setMetadata, appendDelta, appendThinking, appendDiff, appendTool, updateToolResult, nestTool, nestToolResult, upsertTask, setPermission, clearPermission, finishTurn, setTurnRunning]);

  // applyEvent changes identity whenever its store actions do; the hydrate effect
  // below must NOT re-run for that — re-emitting ai:create would truncate and
  // replay over a session that is mid-stream.
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; });

  // Store action held by ref for the same reason as applyEvent: the hydrate effect
  // must key on session identity, not on an action identity that changes per render.
  const initSessionRef = useRef(initSession);
  useEffect(() => { initSessionRef.current = initSession; });

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
  // The re-ask ladder for a hydrate nobody answered; decisions live in the lib, this
  // holds the one timer they drive.
  const ladderRef = useRef(null);
  if (ladderRef.current == null) ladderRef.current = createRetryLadder();
  const retryTimerRef = useRef(null);
  // The debounce in front of the one door, and the ack watchdog of the round it opens.
  const hydrateDebounceRef = useRef(null);
  const releaseTimerRef = useRef(null);
  // Holds `requestHydrate`, assigned once the callback exists. The ladder's timer fires
  // outside React's render, so it reaches the door through this.
  const doorRef = useRef({});
  // The session whose round last owned the gate, so a re-run for the SAME session
  // (workspacePath resolving late) cannot open it a second time.
  const gateSessionRef = useRef(null);

  const clearHydrateRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    ladderRef.current?.answered();
  }, []);

  // The one door into a hydrate. Every trigger (carrier rejoin, resume) reaches it
  // through `doorRef`, so a resume that fires several of them within milliseconds still
  // costs one round-trip. A request that lands while a round is in flight is NOT dropped
  // and NOT stacked: it arms one rung of the ladder, which stands the failure timer down
  // if that round answers and re-asks if it does not.
  const scheduleHydrateRetry = useCallback(() => {
    const delay = ladderRef.current?.schedule(useConnectionStore.getState().connected);
    if (delay == null) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      ladderRef.current?.fired();
      // Through the door, not straight at the host: another trigger may have fired
      // while this timer was pending, and two rounds in flight is what the gate forbids.
      doorRef.current.request?.();
    }, delay);
  }, []);

  // 1. Pull the host's event log for this session. The host is authoritative, so a
  // client rebuilds its view from it (truncate then replay) rather than trusting its
  // own localStorage — that is what makes web 3000 / agent UI / mobile show one
  // identical history. It is also the reconnect path: a carrier that dropped while
  // the phone slept took its events with it, and this is the only way back.
  const hydrateNow = useCallback(() => {
    if (!sessionId || !bus) return;
    // One round at a time. Without this, mount + terminal:ready + carrier rejoin each
    // emit their own ai:create within a few ms of each other, and the older ack lands
    // over the newer cycle's replay. A request that arrives mid-round is not dropped:
    // it arms the ladder, which stands down if this round answers and re-asks if not.
    if (hydratingRef.current) { scheduleHydrateRetry(); return; }
    const gen = ++hydrateSeqRef.current;
    hydratingRef.current = true;
    setHydrating(true);
    pendingLiveRef.current = [];
    olderSeqRef.current = 0;
    // Drains the held events in arrival order, skipping any the snapshot covers.
    const releaseHeld = () => {
      const queued = pendingLiveRef.current;
      pendingLiveRef.current = [];
      hydratingRef.current = false;
      setHydrating(false);
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
      // Nobody answered — the pane would hold a partial view with no way to page back.
      scheduleHydrateRetry();
    }, HYDRATE_TIMEOUT_MS);
    releaseTimerRef.current = releaseTimer;
    // A brand-new session starts fully permitted; the host ignores this once it has
    // a snapshot, so reopening an old chat keeps the mode that chat ran with.
    bus.emit("ai:create", {
      sessionId,
      engine,
      cwd: workspacePath,
      options: { defaultMode: getEngineConfig(engine).defaultMode }
    }, (res) => {
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
        // TEMP DIAGNOSTIC — what the host's tail actually carried. hasMore false here
        // means the pane will never offer "load older", so scroll-up is a dead end by
        // construction. Remove with the rest of the ai-page logging.
        termLog("ai-page", "hydrate", {
          sessionId, replayed: events.length, hasMore: res.session.hasMore, fromSeq: events[0]?.seq ?? 0,
          lastSeq: snapshotSeq, oldestId: null
        });
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
        // Only a real answer stands the ladder down. A rejected ack (`rtc-closed` is how
        // the carrier reports a dead RTC) means the host was never reached, so the rung
        // armed while this round was in flight keeps its timer — and one that was never
        // armed is armed now, or that dropped frame costs the pane its history for good.
        if (res?.ok) { setSynced(true); clearHydrateRetry(); }
        else scheduleHydrateRetry();
      }
    });
  }, [sessionId, engine, workspacePath, bus, setTurnRunning, scheduleHydrateRetry, clearHydrateRetry]);

  const requestHydrate = useCallback(() => {
    // Offline, the send would sit in the carrier's buffer to be answered by a host that
    // has moved on — the bus "connect" trigger asks again once there is someone to ask.
    if (!useConnectionStore.getState().connected) return;
    if (hydrateDebounceRef.current) return; // burst already pending
    hydrateDebounceRef.current = setTimeout(() => {
      hydrateDebounceRef.current = null;
      hydrateNow();
    }, RECOVER_DEBOUNCE_MS);
  }, [hydrateNow]);

  // The debounce and the ladder's timer both fire outside React's render, so they reach
  // the newest callback through a ref rather than through a captured closure. Nothing
  // clears this: the only caller is the ladder's timer, and the effect below stops it.
  useEffect(() => {
    doorRef.current = { request: requestHydrate };
  }, [requestHydrate]);

  // Leaving the session stops every timer that could emit for it, and drops the gate. Both
  // matter for a StrictMode remount, where the refs survive: the ack of a round in flight
  // is cancelled by this cleanup, so without the flag being cleared the next mount would
  // find the gate shut and buffer every live event forever.
  useEffect(() => () => {
    if (hydrateDebounceRef.current) clearTimeout(hydrateDebounceRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    hydrateDebounceRef.current = retryTimerRef.current = releaseTimerRef.current = null;
    hydratingRef.current = false;
    pendingLiveRef.current = [];
  }, []);

  // Initial mount, and every remount that changes the session's identity.
  useEffect(() => {
    if (!sessionId) return;
    // The effect also re-runs when workspacePath resolves (the session list lands after
    // the pane), and that is not a new session: opening the gate again there would let a
    // second ai:create out while the first is still in flight. Only a real change of id
    // drops a round the previous session left holding the gate.
    if (gateSessionRef.current !== sessionId) {
      gateSessionRef.current = sessionId;
      hydratingRef.current = false;
      // A different chat has not been answered for yet, whatever the last one did.
      setSynced(false);
    }
    // Held in a ref: re-running this effect on a store-action identity change would
    // re-emit ai:create over a session that is mid-stream.
    initSessionRef.current(sessionId);
    // Straight at the host, NOT through requestHydrate: on a cold start no carrier is
    // ready yet and that door would drop the ask, while the carrier's "connect" only
    // fires on LATER rejoins — the pane would sit empty over a healthy host until the
    // user hit refresh. PM buffers the emit and flushes it on the first adapter, which
    // is the behavior this mount has always relied on. A rejoin landing in the same
    // breath is then held off by the in-flight gate above, not by a delay.
    return hydrateNow();
  }, [sessionId, hydrateNow]);

  // Backgrounded-then-resumed, and carrier rejoin (the same triggers the terminal
  // recovers on). A live app that never remounts has no other path: the store is not
  // persisted, so events lost while the carrier was down stay lost until the pane is
  // remounted. A resume fires both triggers within ms — the one door debounces them into
  // one round-trip.
  useEffect(() => {
    if (!bus || !sessionId) return;
    // Online is the door's own check, so a resume while offline needs no branch here:
    // the `connect` below fires when there is someone to ask.
    const onVisible = () => {
      if (!document.hidden) requestHydrate();
    };
    bus.on("connect", requestHydrate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      bus.off("connect", requestHydrate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [bus, sessionId, requestHydrate]);

  // 2. Subscribe to AI bus events
  useEffect(() => {
    if (!bus || !sessionId) return;

    // The CLI emits one `delta` per token. Applying each one immediately is one store
    // write, one localStorage round-trip and one React commit per token — thousands a
    // turn, for text that is only ever read at screen refresh rate. Text and thinking
    // are pure appends with no ordering against each other, so they accumulate here and
    // land once per frame. Everything else (a tool, a permission gate, turn_complete)
    // must not wait: it changes what the pane is allowed to do, not just what it shows.
    let bufferedText = "";
    let bufferedThinking = "";
    let flushHandle = null;
    const flushStreamed = () => {
      // Dropped either way: called from the frame itself this is a no-op, and called
      // synchronously from an event below it stops that frame from firing again on an
      // empty buffer and stealing the next batch's schedule.
      if (flushHandle != null) cancelAnimationFrame(flushHandle);
      flushHandle = null;
      const text = bufferedText;
      const thinking = bufferedThinking;
      bufferedText = "";
      bufferedThinking = "";
      const apply = applyEventRef.current;
      if (text) apply(sessionId, "delta", { text });
      if (thinking) apply(sessionId, "thinking", { text: thinking });
    };
    const bufferStream = (event, text) => {
      if (!text) return;
      if (event === "delta") bufferedText += text;
      else bufferedThinking += text;
      if (flushHandle == null) flushHandle = requestAnimationFrame(flushStreamed);
    };

    const handleAiEvent = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      // Mid-hydrate: the store is about to be reset and replayed, so applying now
      // would be thrown away. Hold it; the ack drains this queue after the replay.
      if (hydratingRef.current) {
        pendingLiveRef.current.push(payload);
        return;
      }
      // Text held for this frame goes in first: anything below either changes what the
      // pane may do, or restarts the log the text belongs to.
      if (payload.event === "delta" || payload.event === "thinking") {
        bufferStream(payload.event, payload.data?.text);
        return;
      }
      flushStreamed();
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
      // A pane closing mid-frame must not swallow the last tokens it received.
      flushStreamed();
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
      // Sending is what marks the previous turn read (the terminal side clears on typing) —
      // focusing the composer is not. The store emits clearStatus down to the host itself.
      useNotificationStore.getState().clearNotification(sessionId);
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

  // Ask the host what this conversation can rewind to. Returns null when the engine
  // cannot — the caller hides the control rather than offering a button that no-ops.
  const listRewindPoints = useCallback(async () => {
    const b = busRef.current || useConnectionStore.getState().bus;
    if (!b) return null;
    const res = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
      b.emit("ai:rewind", { sessionId, action: "list" }, done);
    });
    if (!res?.ok) return null;
    return { points: res.points || [], support: res.support };
  }, [sessionId]);

  /**
   * Rewind the conversation (and, when the engine can, the files) to a user turn.
   *
   * The host does the work and broadcasts a conversation_reset, so this returns once
   * the host has acted — the store is rebuilt from that broadcast, not from here. A
   * local truncate would be a lie the next hydrate would undo.
   */
  const rewindToMessage = useCallback(
    async (messageId, newText, { files = true, preview = false } = {}) => {
      const b = busRef.current || useConnectionStore.getState().bus;
      if (!b) return { ok: false, error: "Not connected to the host." };
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
        b.emit("ai:rewind", { sessionId, action: preview ? "preview" : "apply", messageId, files }, done);
      });
      if (!res) return { ok: false, error: "The host did not answer in time." };
      if (!res.ok) return res;
      // Re-submit the edited text as the first prompt of the rewound conversation.
      if (!preview && newText) {
        b.emit("ai:prompt", { sessionId, message: newText, cwd: workspacePath });
      }
      return res;
    },
    [sessionId, workspacePath]
  );

  /** What a rewind to this message would change, without changing anything. */
  const previewRewind = useCallback(
    (messageId, { files = true } = {}) => rewindToMessage(messageId, null, { files, preview: true }),
    [rewindToMessage]
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
      const t0 = Date.now();
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
        b.emit("aiHistory", { sessionId, before: logSeq }, done);
      });
      // TEMP DIAGNOSTIC — the host side of the scroll-up fetch. A null ack means nobody
      // answered (carrier or route), success:false means the host had nothing to give.
      // Remove once paging is confirmed end to end.
      termLog("ai-page", "loadOlder", {
        sessionId, before: logSeq, ms: Date.now() - t0, transport: b.transport || b.carrier || "?",
        res: res == null ? "TIMEOUT/no-ack" : { success: res.success, events: res.events?.length, hasMore: res.hasMore, error: res.error }
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
    hydrating,
    synced,
    hasOlder,
    loadOlder,
    // Re-pull the host's log for this session. Mount, resume and reconnect call it
    // on their own; the pane's refresh button is the manual one for when a run of
    // events was lost while the carrier was up.
    reload: hydrateNow,
    sendPrompt,
    resolvePermission,
    stop,
    runShell,
    rewindToMessage,
    previewRewind,
    listRewindPoints,
    escalateMode,
    dismissBlocked
  };
}
