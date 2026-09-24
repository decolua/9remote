"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { parseEngineTaskEvent, parseEngineTaskResult, getEngineConfig } from "../registry";
import { updateToolTree, settleRunningTools } from "../lib/toolTree";
import { applyTaskRecord, foldTaskRecords, noticeFrom, lastIndexOfCompacting } from "../lib/harnessTasks";
import { upsertTask } from "../lib/taskList";
import { estimateMessageBytes } from "../lib/messageWindow";
import { collectOlderPage } from "../lib/olderPaging";
import { createRetryLadder, shouldApplyHydrateAck } from "../lib/hydrateRetry";
import { isAlreadyApplied } from "../lib/seqDedupe";
import { termLog } from "@/shared/utils/termLog";
import { RECOVER_DEBOUNCE_MS, PEEK_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";
import { RESOLVE_ACK_TIMEOUT_MS } from "../constants";

// CLI reports skills as bare id strings, the agent scan as objects; normalize to one shape.
const normalizeSkills = (skills) =>
  Array.isArray(skills)
    ? skills.map((s) => (typeof s === "string" ? { id: s, name: s, description: "" } : s))
    : [];
const HYDRATE_TIMEOUT_MS = 4000;
// Ack-wait budget; a carrier that dies mid-flight never calls back.
const HISTORY_TIMEOUT_MS = 4000;
// A rewind spawns the CLI twice on the host, each allowed a minute — the fetch budget reported a working one as failed.
const REWIND_APPLY_TIMEOUT_MS = 130000;

// The CLI reports some failures twice (streamed prose + `result`); only the last message is checked to stay cheap.
function alreadySaid(messages, text) {
  const said = String(text || "").trim();
  if (!said) return false;
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === "assistant" && String(last.content || "").trim().endsWith(said));
}

// A refused prompt: the text rides the row so a reload still shows what never sent.
const refusedNoticeContent = (data) =>
  data?.text ? `Not sent — ${data.reason || "the turn is still running"}: ${data.text}` : data?.reason || "Not sent";

// Reduces an event log to a full snapshot in RAM, avoiding thousands of store dispatches.
export function reduceSessionEvents(events = [], engine = "claude", idBase = 0) {  const messages = [];
  let tasks = [];
  // Folded at the end via lib/harnessTasks so replay and the live store share one reader.
  const harnessRecords = [];
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
        // Engines emit init more than once; a later one without skills must not wipe known ones.
        const incoming = normalizeSkills(data?.skills);
        const skills = incoming.length > 0 ? incoming : metadata.skills;
        // An adapter that never learned a model publishes "" — must not blank the chip.
        const { model: initModel, ...initRest } = data || {};
        metadata = { ...metadata, ...initRest, skills, ...(initModel ? { model: initModel } : {}) };
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
      // A sub-agent tool call, nested under its parent card; dropped when the parent is absent.
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
          if (t) tasks = upsertTask(tasks, t);
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
        if (taskRes) tasks = upsertTask(tasks, taskRes);
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
        if (data?.effort) metadata.effort = data.effort;
        break;
      case "turn_complete":
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        if (data?.stats) stats = { ...stats, ...data.stats };
        if (messages.length > 0) messages[messages.length - 1].isLive = false;
        // A failed turn draws the CLI's own sentence; alreadySaid guards its double report.
        if (data?.isError && !alreadySaid(messages, data.result)) {
          messages.push({
            id: `n-${++msgSeq}`, role: "notice", subtype: data.subtype || "",
            level: "error", content: data.result || "The turn ended in an error."
          });
        }
        break;
      case "stats":
        if (data?.stats) stats = { ...stats, ...data.stats };
        break;
      case "stopped":
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        break;
      case "stall":
        // Watchdog timeout guess — end the turn, but a slow build must not read as an error.
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        for (const m of messages) if (m.isLive) m.isLive = false;
        break;
      case "exit":
        turnEnded = true;
        // The CLI process went away — end the turn and drop the gate (claudeAdapter only).
        isTurnRunning = false;
        activePermission = null;
        for (const m of messages) if (m.isLive) m.isLive = false;
        // `code` 0 with no error is an ordinary exit — only a bad one draws the row.
        if (data?.error || (data?.code != null && data.code !== 0)) {
          messages.push({
            id: `n-${++msgSeq}`, role: "notice", subtype: "exit", level: "error",
            content: data.error || `The AI process exited (code ${data.code}).`
          });
        }
        break;
      case "error":
        turnEnded = true;
        // An error can land mid-turn (opencode blocked actions) — close the streaming bubble.
        isTurnRunning = false;
        for (const m of messages) if (m.isLive) m.isLive = false;
        messages.push({
          id: `n-${++msgSeq}`,
          role: "notice",
          subtype: "error",
          level: "error",
          content: data?.message || "AI process failed"
        });
        break;
      case "prompt_refused":
        // Not a turn ending: the running turn keeps its flag; text rides the notice for reload.
        messages.push({
          id: `n-${++msgSeq}`, role: "notice", subtype: "prompt_refused", level: "error",
          content: refusedNoticeContent(data)
        });
        break;
      case "conversation_reset":
        messages.length = 0;
        tasks.length = 0;
        harnessRecords.length = 0;
        isTurnRunning = false;
        activePermission = null;
        activeBlocked = null;
        break;
      // Records with no card yet are kept, not dropped — the pane may learn to draw them.
      case "cli_event": {
        const type = data?.type || "";
        const record = data?.record || null;
        harnessRecords.push([type, data?.subtype || "", record, data?.ageMs]);
        const notice = noticeFrom(type, record);
   if (!notice) break;
        // A settled compaction replaces the "Compacting…" row it ends; compactSettled is a wire flag, not row data.
        const { compactSettled, ...row } = notice;
        // Scan back, not last row: another record can sit between a compaction's start and end.
        const runningAt = compactSettled ? lastIndexOfCompacting(messages) : -1;
        if (runningAt !== -1) {
          if (row.content?.trim()) messages[runningAt] = { id: `n-${++msgSeq}`, role: "notice", ...row };
          else messages.splice(runningAt, 1);
          break;
        }
        if (!row.content?.trim()) break;
        // Drop the empty assistant placeholder so a notice does not leave a bare bubble.
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && !last.content && !last.thinking && !(last.tools || []).length) {
          messages.pop();
        }
        messages.push({ id: `n-${++msgSeq}`, role: "notice", ...row });
        break;
      }
      default:
        break;
    }
  }

  // Keyed on turnEnded, not isTurnRunning: a reduced older page carries no end event.
  if (turnEnded) {
    for (const m of messages) if (m.tools) m.tools = settleRunningTools(m.tools);
  }

  let harnessTasks = [];
  for (const [type, subtype, record] of harnessRecords) harnessTasks = applyTaskRecord(harnessTasks, type, subtype, record);

  return {
    messages, tasks, metadata, stats, isTurnRunning, activePermission, activeBlocked, permissionMode,
    harnessRecords,
    harnessTasks
  };
}

export function useAiSession({
  sessionId,
  engine = "claude",
  workspacePath = "",
  bus = null,
  isVisible = true
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
  // Boolean selector: re-renders on carrier changes only.
  const connected = useConnectionStore((s) => s.connected);

  // Host events older than the replayed tail, unfetched until scroll-up.
  const [hasOlder, setHasOlder] = useState(false);
  // Mirrors hydratingRef as state so the status line can repaint.
  const [hydrating, setHydrating] = useState(false);
  // Has the host ever answered this session; only an ok ack counts as an answer.
  const [synced, setSynced] = useState(false);
  // The re-ask ladder ran out — the pane offers a retry instead of spinning.
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const olderSeqRef = useRef(0);
  const loadingOlderRef = useRef(false);

  // Dispatch-only by design: subscribing here would rebuild the hook per streamed frame.

  // One door for live and replay alike: the host is the source of truth.
  const applyEvent = useCallback((sid, event, data) => {
    switch (event) {
      case "user_message":
        // `replay` marks a re-sent log: the prompt already happened, so it opens no turn.
        addUserMessage(sid, data.text, data.attachments || null, Boolean(data?.replay));
        break;
      case "init": {
        // Keep persisted descriptions when the CLI's bare ids arrive second.
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
        // An init with no model is not news — must not blank the chip.
        const { model: initModel, ...initRest } = data || {};
        setMetadata(sid, { ...initRest, skills, ...(initModel ? { model: initModel } : {}) });
        break;
      }
      case "goal":
        // A null goal means "none set" and clears the one already shown.
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
        if (data?.effort) setMetadata(sid, { effort: data.effort });
        break;
      case "queue_update":
        useAiStore.getState().setQueue(sid, data?.queue || []);
        break;
      // The host's span is the honest number for a client that joined mid-turn.
      case "turn_complete":
        finishTurn(sid, data.stats, data.turnMs, Boolean(data?.replay));
        // A failed turn draws the CLI's own sentence, rebuilt on replay too; alreadySaid guards the double report.
        if (data?.isError && !alreadySaid(useAiStore.getState().bySession[sid]?.messages, data.result)) {
          useAiStore.getState().addNotice(sid, {
            subtype: data.subtype || "", level: "error",
            content: data.result || "The turn ended in an error."
          });
        }
        break;
      case "stats":
        // codex/opencode report token usage mid-turn; claude folds it into turn_complete
        if (data?.stats) useAiStore.getState().setStats(sid, data.stats);
        break;
      case "stopped":
      case "exit":
        // The process is gone — drop the gate with it, nothing is left to answer it.
        clearPermission(sid);
        useAiStore.getState().finishTurn(sid, null, data?.turnMs);
        // `stopped` is a deliberate interrupt and says nothing; a nonzero exit is news.
        if (event === "exit" && (data?.error || (data?.code != null && data.code !== 0))) {
          useAiStore.getState().addNotice(sid, {
            subtype: "exit", level: "error",
            content: data.error || `The AI process exited (code ${data.code}).`
          });
        }
        break;
      case "stall":
        // Same release as `stopped`, deliberately without the text `error` appends.
        setTurnRunning(sid, false);
        finishTurn(sid, null, data?.turnMs);
        break;
      case "error":
        // Spawn failures never produce a turn_complete — surface the row and release the turn.
        useAiStore.getState().addNotice(sid, {
          subtype: "error", level: "error",
          content: data?.message || "AI process failed"
        });
        finishTurn(sid, null, data?.turnMs);
        break;
      case "prompt_refused":
        // Deliberately not a finishTurn — the running turn keeps its flag.
        useAiStore.getState().addNotice(sid, {
          subtype: "prompt_refused", level: "error",
          content: refusedNoticeContent(data)
        });
        break;
      case "conversation_reset":
        // The reset rides after the hydrate ack and restates the log's turn state with it.
        termLog("ai-status", "reset", {
          sessionId: sid, isTurnRunning: data?.isTurnRunning, elapsedMs: data?.elapsedMs,
          lastTurnMs: data?.lastTurnMs, fromSeq: data?.fromSeq
        });
        useAiStore.getState().clearMessages(sid);
        // Host task set applied before the replay — the tail alone may miss top-of-turn tasks.
        useAiStore.getState().setTaskRecords(sid, data?.taskRecords);
        useAiStore.getState().restoreTurnState(sid, data);
        if (Array.isArray(data?.queue)) {
          useAiStore.getState().setQueue(sid, data.queue);
        }
        break;
      // Records go to the store as-is; the task fold happens there, like the replay's.
      case "cli_event": {
        const type = data?.type || "";
        const record = data?.record || null;
        useAiStore.getState().applyTaskRecords(sid, [[type, data?.subtype || "", record, data?.ageMs]]);
        // Same rule as the replay: the harness decides which records a person reads.
        const notice = noticeFrom(type, record);
        if (notice) useAiStore.getState().addNotice(sid, notice);
        break;
      }
      default:
        break;
    }
  }, [engine, addUserMessage, setMetadata, appendDelta, appendThinking, appendDiff, appendTool, updateToolResult, nestTool, nestToolResult, upsertTask, setPermission, clearPermission, finishTurn, setTurnRunning]);

  // Ref, not dep: the hydrate effect must not re-emit ai:create over a mid-stream session.
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; });

  // Same reason as applyEvent: key on session identity, not action identity.
  const initSessionRef = useRef(initSession);
  useEffect(() => { initSessionRef.current = initSession; });

  // Highest host seq applied; events at or below it must not be applied twice.
  const appliedSeqRef = useRef(0);
  // Bumped when the host replaces the log; in-flight seqs from the old log must not read as newer.
  const logEpochRef = useRef(0);
  // Live events held during a hydrate — the ack's replay would wipe anything applied now.
  const hydratingRef = useRef(false);
  const pendingLiveRef = useRef([]);
  // Bumped per attempt; a stale StrictMode ack must not release a newer cycle's gate.
  const hydrateSeqRef = useRef(0);
  // Re-ask ladder; delays live in lib/hydrateRetry, this drives its timer.
  const ladderRef = useRef(null);
  if (ladderRef.current == null) ladderRef.current = createRetryLadder();
  const retryTimerRef = useRef(null);
  const hydrateDebounceRef = useRef(null);
  const releaseTimerRef = useRef(null);
  // The ladder's timer fires outside render — it reaches the door through this ref.
  const doorRef = useRef({});
  // Session that last owned the gate; a late workspacePath re-run must not reopen it.
  const gateSessionRef = useRef(null);

  const isVisibleRef = useRef(isVisible);
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const pendingRecoverRef = useRef(null);
  const peekDebounceRef = useRef(null);
  const peekDeadlineRef = useRef(null);

  const clearHydrateRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    ladderRef.current?.answered();
  }, []);

  // One door: a request landing mid-round arms a ladder rung instead of stacking rounds.
  const scheduleHydrateRetry = useCallback(() => {
    const delay = ladderRef.current?.schedule(useConnectionStore.getState().connected);
    // A null delay means offline or a timer already armed — neither is a failure.
    setHydrateFailed(Boolean(ladderRef.current?.exhausted()));
    termLog("ai-hydrate", "ladder", {
      delay: delay ?? null, exhausted: ladderRef.current?.exhausted(),
      connected: useConnectionStore.getState().connected, armed: retryTimerRef.current != null
    });
    if (delay == null) return;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      ladderRef.current?.fired();
      // Through the door: two rounds in flight is what the gate forbids.
      doorRef.current.request?.();
    }, delay);
  }, []);

  // 1. Pull the host's log: truncate then replay — also the only path back after a carrier drop.
  const hydrateNow = useCallback(() => {
    if (!sessionId || !bus) return;
    // One round at a time; a mid-round request arms the ladder instead.
    if (hydratingRef.current) {
      termLog("ai-hydrate", "blocked (round in flight)", { gen: hydrateSeqRef.current });
      scheduleHydrateRetry();
      return;
    }
    const gen = ++hydrateSeqRef.current;
    // Which log this round asks about — see logEpochRef. Bumped by a reset while it flies.
    const epoch = logEpochRef.current;
    hydratingRef.current = true;
    setHydrating(true);
    pendingLiveRef.current = [];
    olderSeqRef.current = 0;
    const sentAt = Date.now();
    termLog("ai-hydrate", "emit ai:create", {
      gen, sessionId, engine, cwd: workspacePath,
      carrier: useConnectionStore.getState().carrier,
      connected: useConnectionStore.getState().connected
    });
    const releaseHeld = () => {
      const queued = pendingLiveRef.current;
      pendingLiveRef.current = [];
      hydratingRef.current = false;
      setHydrating(false);
      for (const p of queued) {
        // A reset restarts the log at seq 1 — the snapshot's watermark no longer applies.
        if (p.event === "conversation_reset") {
          appliedSeqRef.current = 0;
          logEpochRef.current++;
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
    // A lost ack must not shut the gate forever; past this window the snapshot is stale.
    const releaseTimer = setTimeout(() => {
      if (gen !== hydrateSeqRef.current || !hydratingRef.current) return;
      releaseHeld();
      // Nobody answered — the pane would hold a partial view with no way to page back.
      scheduleHydrateRetry();
    }, HYDRATE_TIMEOUT_MS);
    releaseTimerRef.current = releaseTimer;
    // Defaults for a brand-new session only; the host ignores them once it has a snapshot.
    bus.emit("ai:create", {
      sessionId,
      engine,
      cwd: workspacePath,
      options: {
        defaultMode: getEngineConfig(engine).defaultMode,
        defaultEffort: getEngineConfig(engine).defaultEffort
      }
    }, (res) => {
      const isNewest = gen === hydrateSeqRef.current;
      if (!shouldApplyHydrateAck({
        isNewest,
        snapshotSeq: res?.session?.seq,
        appliedSeq: appliedSeqRef.current,
        sameLog: epoch === logEpochRef.current
      })) return;
      let gateToRestore = null;
      let queueToRestore = null;
      const events = res?.session?.events;
      termLog("ai-hydrate", "ack", {
        gen, stale: gen !== hydrateSeqRef.current, ms: Date.now() - sentAt,
        ok: res?.ok ?? null, error: res?.error ?? null,
        events: Array.isArray(events) ? events.length : null,
        hasMore: res?.session?.hasMore ?? null
      });
      try {
        clearTimeout(releaseTimer);
        // An ack with no events array is the only case with nothing to replay.
        if (!res?.ok || !Array.isArray(events)) {
          setHasOlder(false);
          return;
        }
        const snapshotSeq = res.session.seq || 0;
        termLog("ai-status", "hydrate ack", {
          sessionId, isTurnRunning: res.session.isTurnRunning, elapsedMs: res.session.elapsedMs,
          lastTurnMs: res.session.lastTurnMs, events: events.length, hasMore: res.session.hasMore
        });
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
        if (Array.isArray(res?.modelOptions) && res.modelOptions.length > 0) {
          useAiStore.getState().setMetadata(sessionId, { modelOptions: res.modelOptions });
        }
        if (events.length > 0) {
          // Pure in-memory reduction in <3ms instead of 5000+ synchronous store dispatches
          const hydrated = reduceSessionEvents(events, engine);
          useAiStore.getState().hydrateSession(sessionId, {
            messages: hydrated.messages,
            tasks: hydrated.tasks,
            // The host is the authority on spawn-time options: its snapshot carries
            // the effort the CLI actually runs with, which the replay may not. An empty
            // one means the session has no pick of its own — leave the init event's
            // reading alone rather than blanking the chip.
            metadata: {
              ...useAiStore.getState().bySession[sessionId]?.metadata,
              ...hydrated.metadata,
              ...(Array.isArray(res?.modelOptions) ? { modelOptions: res.modelOptions } : {}),
              ...(res.session.effort ? { effort: res.session.effort } : {})
            },
            // The host's counters outrank the replay's: the log holds events, not the
            // adapter's running usage, so a reload would otherwise blank the context row.
            stats: { ...hydrated.stats, ...(res.session.stats || {}) },
            isTurnRunning: res.session.isTurnRunning !== undefined ? Boolean(res.session.isTurnRunning) : hydrated.isTurnRunning,
            // How long that turn has been running, on the host's clock — the pane anchors
            // its own to it, so a reload mid-turn counts the whole turn, not from the F5.
            elapsedMs: res.session.elapsedMs || 0,
            lastTurnMs: res.session.lastTurnMs || 0,
            permissionMode: res.session.permissionMode || hydrated.permissionMode,
            activeBlocked: hydrated.activeBlocked,
            // What the replay's own records rebuilt. Without this the strip came back
            // empty after an F5 while a shell was still running: the log said so, and
            // nobody carried the answer into the store.
            //
            // The host's own task records go FIRST and the window's on top: a task
            // announced at the top of a long turn falls outside the replay tail, so the
            // window alone is not the whole set — the host states it beside the log, the
            // way it states the turn. Same reader folds both, so this is one list, not
            // two that could disagree.
            harnessTasks: foldTaskRecords(res.session.taskRecords, hydrated.harnessTasks),
            queue: res.session.queue || []
          });
        } else {
          setTurnRunning(sessionId, Boolean(res.session.isTurnRunning));
          // An empty window is not an absent task set: a session whose log the host holds
          // but cannot replay (every event over a frame, say) still has its tasks stated
          // beside the log. Skipping this left the strip empty on a session that has one.
          useAiStore.getState().setTaskRecords(sessionId, res.session.taskRecords);
          if (res.session.permissionMode) {
            useAiStore.getState().setPermissionMode(sessionId, res.session.permissionMode);
          }
          if (Array.isArray(res.session.queue)) {
            useAiStore.getState().setQueue(sessionId, res.session.queue);
          }
          // No log to replay, but the adapter still knows what it has spent — a fresh
          // pane on a running session reads the same numbers as the one it replaced.
          if (res.session.stats) useAiStore.getState().setStats(sessionId, res.session.stats);
        }
        // The host states the gate itself when the CLI is holding one, so a request that
        // scrolled off the replay tail — or that the rebuild below never reproduced —
        // still comes back; a card that cannot be reopened leaves the CLI waiting on an
        // answer no surface can give. Held here rather than set above: the reset that
        // comes with a hydrate's ack is drained by the `finally` AFTER this block, and
        // clearMessages drops the card on its way through.
        gateToRestore = res.session.activePermission || null;
        queueToRestore = Array.isArray(res.session.queue) ? res.session.queue : null;
        // The snapshot is authoritative for this log. Assign rather than max: after a
        // /resume or /clear the host starts a NEW log whose seqs begin at 1, so a
        // higher watermark left over from the previous log would drop every replay.
        appliedSeqRef.current = snapshotSeq;
      } finally {
        // Always drains — a failed ack must not discard events that really arrived.
        clearTimeout(releaseTimer);
        if (gen === hydrateSeqRef.current) releaseHeld();
        // After the drain, never before: an ack to a hydrate is accompanied by the host's
        // own conversation_reset, and that reset clears the gate on its way past. Set
        // earlier, the card was wiped a moment after it was drawn — the pane came back
        // from an F5 with an empty composer above a CLI waiting on an answer nobody could
        // reach. The log cannot carry it back either: a rebuild reads the transcript, and
        // a gate is not in there.
        if (gateToRestore && gen === hydrateSeqRef.current) {
          useAiStore.getState().setPermission(sessionId, gateToRestore);
        }
        if (queueToRestore && gen === hydrateSeqRef.current) {
          useAiStore.getState().setQueue(sessionId, queueToRestore);
        }
        // The drained events are HISTORY, and the log they came from ends wherever it ends
        // — a rebuild lands on a turn_complete, and a chat replayed mid-turn carries the
        // prompt that started it. Either way they set the turn flag as a side effect, so
        // this restates what the host says the turn is doing RIGHT NOW: without it a live
        // turn came back from an F5 looking finished (no stop control), and a finished one
        // came back looking live (spinning until the next real event).
        if (res?.ok && res.session.isTurnRunning !== undefined) {
          useAiStore.getState().restoreTurnState(sessionId, {
            isTurnRunning: Boolean(res.session.isTurnRunning),
            elapsedMs: res.session.elapsedMs || 0,
            lastTurnMs: res.session.isTurnRunning ? 0 : (res.session.lastTurnMs || 0)
          });
          // TEMP DIAGNOSTIC — the last word on the turn after the replay is in. If this
          // says one thing and the render line says another, the replay is not the writer.
          termLog("ai-status", "restate", {
            sessionId, isTurnRunning: Boolean(res.session.isTurnRunning),
            elapsedMs: res.session.elapsedMs || 0, lastTurnMs: res.session.lastTurnMs || 0
          });
        }
        // Only a real answer stands the ladder down. A rejected ack (`rtc-closed` is how
        // the carrier reports a dead RTC) means the host was never reached, so the rung
        // armed while this round was in flight keeps its timer — and one that was never
        // armed is armed now, or that dropped frame costs the pane its history for good.
        if (res?.ok) { setSynced(true); setHydrateFailed(false); clearHydrateRetry(); }
        else scheduleHydrateRetry();
        // TEMP DIAGNOSTIC — the state the pane renders from. `synced:false, hydrating:false`
        // is exactly the "Syncing… that never ends" the user sees. Remove with the rest.
        termLog("ai-hydrate", "settled", {
          gen, stale: gen !== hydrateSeqRef.current, ok: res?.ok ?? null,
          hydrating: hydratingRef.current, synced: !!res?.ok
        });
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

  // Check whether host has newer events before doing a full destructive hydrate
  const peekSeqCheck = useCallback(() => {
    if (!bus || !sessionId) return;
    if (!isVisibleRef.current) {
      pendingRecoverRef.current = "visible";
      return;
    }
    if (!useConnectionStore.getState().connected) return;
    if (hydratingRef.current) return;
    if (peekDebounceRef.current) return;
    peekDebounceRef.current = setTimeout(() => {
      peekDebounceRef.current = null;
      if (!isVisibleRef.current || hydratingRef.current) return;
      // A peek nobody answers (an older agent without the handler, or every carrier
      // zombie on a mobile resume) must not leave the pane stale: fall back to the
      // full hydrate, whose own ladder keeps re-asking. A late ack after the deadline
      // still runs its comparison — requestHydrate is debounced, so the worst case
      // is a no-op, never a second round.
      let answered = false;
      const deadline = setTimeout(() => {
        if (answered) return;
        termLog("ai-hydrate", "peekSeq: no ack → full hydrate");
        requestHydrate();
      }, PEEK_TIMEOUT_MS);
      peekDeadlineRef.current = deadline;
      bus.emit("ai:peekSeq", { sessionId }, (res) => {
        answered = true;
        clearTimeout(deadline);
        peekDeadlineRef.current = null;
        if (!res?.ok || typeof res.seq !== "number") {
          requestHydrate();
          return;
        }
        const lastSeq = appliedSeqRef.current;
        const currentTurnRunning = Boolean(useAiStore.getState().bySession[sessionId]?.isTurnRunning);
        const currentQueueLen = useAiStore.getState().bySession[sessionId]?.queue?.length || 0;
        const hostQueueLen = typeof res.queueLength === "number" ? res.queueLength : currentQueueLen;
        if (res.seq === lastSeq && Boolean(res.isTurnRunning) === currentTurnRunning && hostQueueLen === currentQueueLen) {
          termLog("ai-hydrate", "peekSeq: nothing missed", { seq: lastSeq });
          return;
        }
        termLog("ai-hydrate", "peekSeq: state changed", { fromSeq: lastSeq, toSeq: res.seq, turn: res.isTurnRunning });
        requestHydrate();
      });
    }, RECOVER_DEBOUNCE_MS);
  }, [bus, sessionId, requestHydrate]);

  // The ladder's timer re-asks through the door, so an automatic retry keeps the same
  // spacing. A tap is the user saying "now": drop the pending rung and ask immediately —
  // otherwise the pane would spin for another 6s over a request the user already made.
  const retryNow = useCallback(() => {
    clearHydrateRetry();
    hydrateNow();
  }, [clearHydrateRetry, hydrateNow]);

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
    if (peekDebounceRef.current) clearTimeout(peekDebounceRef.current);
    if (peekDeadlineRef.current) clearTimeout(peekDeadlineRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    hydrateDebounceRef.current = peekDebounceRef.current = peekDeadlineRef.current = retryTimerRef.current = releaseTimerRef.current = null;
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
      // A different chat has not been answered for yet, whatever the last one did. The
      // ladder is reset with it: a spent ladder would otherwise report the new chat as
      // already failed and re-ask on the last rung before its first round came back.
      clearHydrateRetry();
      setSynced(false);
      setHydrateFailed(false);
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
  }, [sessionId, hydrateNow, clearHydrateRetry]);

  // Resume recovery and visibility: only check seq if visible; hidden panes defer.
  useEffect(() => {
    if (!isVisible) return;
    const pending = pendingRecoverRef.current;
    if (!pending) return;
    pendingRecoverRef.current = null;
    if (pending === "reconnect") requestHydrate();
    else peekSeqCheck();
  }, [isVisible, requestHydrate, peekSeqCheck]);

  // Backgrounded-then-resumed, and carrier rejoin (the same triggers the terminal
  // recovers on). A live app that never remounts has no other path: the store is not
  // persisted, so events lost while the carrier was down stay lost until the pane is
  // remounted. A resume fires both triggers within ms — the one door debounces them into
  // one round-trip.
  useEffect(() => {
    if (!bus || !sessionId) return;
    // Online is the door's own check, so a resume while offline needs no branch here —
    // the `connected` effect below asks once there is someone to answer.
    const onVisible = () => {
      if (!document.hidden) peekSeqCheck();
    };
    const onConnect = () => {
      if (!isVisibleRef.current) {
        pendingRecoverRef.current = "reconnect";
        return;
      }
      requestHydrate();
    };
    // Page Lifecycle `resume`: Chrome Android wakes a frozen tab without firing a
    // visibilitychange (the same gap pmWatchers covers on the transport side). bfcache
    // restores need nothing extra — those do fire visibilitychange.
    bus.on("connect", onConnect);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("resume", onVisible);
    return () => {
      bus.off("connect", onConnect);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onVisible);
    };
  }, [bus, sessionId, peekSeqCheck, requestHydrate]);

  // The carrier coming back is a trigger in its own right, not just a prelude to the
  // bus "connect" above. That event only fires on a rejoin the PM judges worthwhile
  // (_maybeFireRejoin), and it stays silent whenever the OTHER carrier is still ready —
  // so the case this covers is a phone that slept through a full outage: the resume fires
  // while both carriers are dead, requestHydrate drops that ask, and the carriers then
  // return without ever announcing a "connect". The pane kept its pre-sleep view, and the
  // refresh button was the only way back. Asking here is that dropped ask, remembered.
  //
  // The EDGE only. On mount `connected` is often already true, and re-running there would
  // buy a second full replay 150ms after the mount's own hydrate — for nothing.
  const wasConnectedRef = useRef(true);
  useEffect(() => {
    const was = wasConnectedRef.current;
    wasConnectedRef.current = connected;
    if (connected && !was) {
      if (!isVisibleRef.current) {
        pendingRecoverRef.current = "reconnect";
        return;
      }
      requestHydrate();
    }
  }, [connected, requestHydrate]);

  // 2. Subscribe to AI bus events
  useEffect(() => {
    if (!bus || !sessionId) return;

    // The CLI emits one `delta` per token. Applying each one immediately is one store
    // write, one localStorage round-trip and one React commit per token — thousands a
    // turn, for text that is only ever read at screen refresh rate. Text and thinking
    // are pure appends with no ordering against each other, so they accumulate here and
    // land once per frame. Everything else (a tool, a permission gate, turn_complete)
    // must not wait: it changes what the pane is allowed to do, not just what it shows.
    //
    // Non-stream events no longer flush those buffers synchronously. Every store set
    // notifies React subscribers synchronously, so a burst delivering thinking
    // interleaved with tool/status events interleaved writes with renders until React's
    // nested-update guard tripped ("Maximum update depth exceeded" — the crash frame
    // pointed at appendThinking). Both halves of such a burst now queue and land in one
    // microtask drain: the writes coalesce, React renders once per delivery task.
    let bufferedText = "";
    let bufferedThinking = "";
    let flushHandle = null;
    let pendingEvents = [];
    let drainScheduled = false;
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
      if (text || thinking) {
        useAiStore.getState().appendStream(sessionId, text, thinking);
      }
    };
    const bufferStream = (event, text) => {
      if (!text) return;
      if (event === "delta") bufferedText += text;
      else bufferedThinking += text;
      if (flushHandle == null) flushHandle = requestAnimationFrame(flushStreamed);
    };
    // One drain per delivery task, in arrival order. A stream item is the text buffered
    // ahead of the event queued behind it — folding it in here keeps "text lands before
    // the tool/gate it preceded" true without a synchronous flush.
    const drainPending = () => {
      drainScheduled = false;
      const batch = pendingEvents;
      pendingEvents = [];
      const apply = applyEventRef.current;
      for (const item of batch) {
        if (item.stream) useAiStore.getState().appendStream(sessionId, item.data.text, item.data.thinking);
        else apply(sessionId, item.event, item.data);
      }
    };
    const queueEvent = (event, data) => {
      // Whatever streams buffered so far arrived BEFORE this event, and must not land
      // after it: a reset queued behind them would clear text the reader was shown, and
      // a tool card would jump ahead of prose that followed it. cli_event is the
      // exception: it is bookkeeping (tasks/notices), changes nothing the pane may do,
      // and a thinking stream carries one per token — folding each one out would
      // re-impose the per-token store write the buffer exists to prevent.
      if (event !== "cli_event" && (bufferedText || bufferedThinking)) {
        const item = { stream: true, data: { text: bufferedText, thinking: bufferedThinking } };
        bufferedText = "";
        bufferedThinking = "";
        if (flushHandle != null) { cancelAnimationFrame(flushHandle); flushHandle = null; }
        pendingEvents.push(item);
      }
      pendingEvents.push({ event, data });
      if (!drainScheduled) {
        drainScheduled = true;
        queueMicrotask(drainPending);
      }
    };

    const handleAiEvent = (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      // Mid-hydrate: the store is about to be reset and replayed, so applying now
      // would be thrown away. Hold it; the ack drains this queue after the replay.
      if (hydratingRef.current) {
        pendingLiveRef.current.push(payload);
        return;
      }
      // Anything below either changes what the pane may do, or restarts the log the
      // buffered text belongs to — queueEvent folds that text in ahead of the event it
      // preceded, so the order the reader sees is still the order the host sent.
      const isStream = payload.event === "delta" || payload.event === "thinking";
      // A reset means the host is starting a NEW log whose seqs begin again at 1.
      // The old watermark would drop every replayed event as "already applied", so
      // it must be cleared before the replay that follows.
      if (payload.event === "conversation_reset") {
        appliedSeqRef.current = 0;
        logEpochRef.current++;
        // The window belongs to the log that just ended. Keeping it would make the next
        // scroll-up fetch seqs the fresh log already replays — every turn rendered twice.
        // The host replays a tail only, so the reset states where that tail starts.
        olderSeqRef.current = payload.data?.fromSeq ?? 0;
        setHasOlder(Boolean(payload.data?.hasMore));
        queueEvent(payload.event, payload.data);
        return;
      }
      // Already covered by a replay this client hydrated from — applying it again
      // would duplicate the message. The rule itself is pinned in lib/seqDedupe.
      // Ahead of the stream branch, not behind it: a delta replayed by the same hydrate
      // that just reset the store appended its text a second time, so the answer grew a
      // duplicate tail while the prompt bubble (a non-stream event) was already covered.
      if (isAlreadyApplied(payload.seq, appliedSeqRef.current)) return;
      if (payload.seq != null) appliedSeqRef.current = payload.seq;
      if (isStream) {
        bufferStream(payload.event, payload.data?.text);
        return;
      }
      queueEvent(payload.event, payload.data);
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
    (text, { attachments = null } = {}) => {
      if (!text && !attachments?.length) return;
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
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

  const removeQueueItem = useCallback(
    (id) => {
      const curr = useAiStore.getState().bySession[sessionId]?.queue || [];
      useAiStore.getState().setQueue(sessionId, curr.filter((item) => item.id !== id));
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
      b?.emit("ai:queueRemove", { sessionId, id });
    },
    [sessionId]
  );

  const clearQueue = useCallback(
    () => {
      useAiStore.getState().setQueue(sessionId, []);
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
      b?.emit("ai:queueClear", { sessionId });
    },
    [sessionId]
  );

  const resolvePermission = useCallback(
    (requestId, behavior, message = "", answers = null) => {
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
      if (!b) return;
      // Cleared only on the host's ok. Dropping the card first meant an emit that fell
      // into a dead carrier (an F5 mid-answer) left the user with no card and no answer
      // sent — the chat then sat on a CLI waiting for a gate nobody could reach.
      let settled = false;
      let timer = null;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // `stale` is not a failure the user must retry: the CLI has already moved past
        // this gate (it was answered elsewhere, or the process was replaced).
        if (res?.ok || res?.reason === "stale") {
          clearPermission(sessionId, requestId);
          return;
        }
        // The host refused, or the ack never came. The card stays, and says so — a gate
        // the user believes they answered is the worst version of this bug.
        termLog("ai-gate", "resolve failed", { requestId, behavior, res: res ?? "timeout" });
        useAiStore.getState().setGateError(sessionId, requestId);
      };
      if (answers) b.emit("ai:question", { sessionId, requestId, answers }, done);
      else b.emit("ai:permission", { sessionId, requestId, behavior, message }, done);
      // An emit into a dead carrier never reaches the ack timer at all — nothing calls
      // back and nothing errors, so the card must time out on its own.
      timer = setTimeout(() => done(null), RESOLVE_ACK_TIMEOUT_MS);
    },
    [sessionId, clearPermission]
  );

  const stop = useCallback(() => {
    const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
    b?.emit("ai:stop", { sessionId });
    // Deliberately NOT clearing isTurnRunning here. The host ends the turn and broadcasts
    // `stopped` with the span it measured (`turnMs`) — lowering the flag locally first made
    // the pane see the falling edge before that number arrived, so it froze the summary
    // from its own clock and printed "Worked for 0s" over a turn that had just run for
    // minutes. One door: the host ends the turn, the client only renders it.
  }, [sessionId]);

  // Stop ONE background task. Fire and forget like the host side: the CLI reports the
  // stop as a `task_notification`, which is what settles the row — an optimistic local
  // update would claim an end that may not have happened.
  const stopTask = useCallback(
    (taskId) => {
      if (!taskId) return;
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
      b?.emit("ai:stopTask", { sessionId, taskId });
    },
    [sessionId]
  );

  const runShell = useCallback(
    (command) => {
      sendPrompt(`! ${command}`);
    },
    [sendPrompt]
  );

  // Ask the host what this conversation can rewind to.
  //
  // Four different answers, and the pane needs them apart: the engine cannot rewind
  // (stop asking, hide the control), the engine can but its conversation is not readable
  // yet (keep asking — the CLI publishes that a turn later), a list of turns (stop), and
  // a host that did not answer (retry). A plain null would collapse the middle two into
  // "unsupported", which is how the control went missing for good on a fresh chat.
  const listRewindPoints = useCallback(async () => {
    const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
    if (!b) return null;
    const res = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
      b.emit("ai:rewind", { sessionId, action: "list" }, done);
    });
    if (!res) return null;
    if (!res.support?.conversation) return { supported: false, ok: false, points: [], support: res.support };
    if (!res.ok) return { supported: true, ok: false, points: [], support: res.support };
    return { supported: true, ok: true, points: res.points || [], support: res.support };
  }, [sessionId]);

  /**
   * Rewind the conversation (and, when the engine can, the files) to a user turn.
   *
   * The host does the work and broadcasts a conversation_reset, so this returns once
   * the host has acted — the store is rebuilt from that broadcast, not from here. A
   * local truncate would be a lie the next hydrate would undo.
   *
   * `index` is a turn counted from the END of the thread, for callers that hold only
   * their own display ids. `messageId` is the CLI's own id, which the rewind modal has
   * because it listed the turns from the host.
   */
  const rewindToMessage = useCallback(
    async (messageId, newText, { files = true, preview = false, index = null } = {}) => {
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
      if (!b) return { ok: false, error: "Not connected to the host." };
      const res = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(null), preview ? HISTORY_TIMEOUT_MS : REWIND_APPLY_TIMEOUT_MS);
        b.emit("ai:rewind", { sessionId, action: preview ? "preview" : "apply", messageId, index, files }, done);
      });
      // A failed apply has to put back what the pane dropped on the press. The host's
      // own log is the only honest source — the local slice cannot know what the CLI
      // actually kept. Without this, a refusal left a pane that had already lost the
      // turns it was told were still there.
      if (!preview && (!res || !res.ok)) retryNow();
      if (!res) return { ok: false, error: "The host did not answer in time." };
      if (!res.ok) return res;
      // Re-submit the edited text as the first prompt of the rewound conversation. This
      // is the feature, not a convenience: the rewind drops the turn, and the edited
      // version is what replaces it. `res.prefillText` is the CLI's own copy of the turn
      // that went — identical here, and there for a caller with no text of its own.
      if (!preview && newText) {
        b.emit("ai:prompt", { sessionId, message: newText, cwd: workspacePath });
      }
      return res;
    },
    [sessionId, workspacePath, retryNow]
  );

  /** What a rewind to this message would change, without changing anything. */
  const previewRewind = useCallback(
    (messageId, { files = true, index = null } = {}) => rewindToMessage(messageId, null, { files, preview: true, index }),
    [rewindToMessage]
  );

  // Escalate out of a blocked action: switch to the mode the card proposed and
  // clear the card. The host applies the mode to the CLI.
  const escalateMode = useCallback(
    (mode) => {
      if (!mode) return;
      useAiStore.getState().setPermissionMode(sessionId, mode);
      useAiStore.getState().clearBlocked(sessionId);
      const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
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
    const b = busRef.current; // no store fallback — null (foreign bus not up) must wait, not hit the main machine
    if (!b) return false;
    loadingOlderRef.current = true;
    // The log may be replaced while this is in flight (/resume, /clear). The chunk is
    // older events of a conversation that is no longer shown, so its ack stands down
    // instead of prepending one log's turns onto another's.
    const logSeq = olderSeqRef.current;
    try {
      const t0 = Date.now();
      // One tap buys a PAGE, not a frame. The loop's rules live in lib/olderPaging so a
      // test drives the real code rather than a copy of it — the copy is what let a dead
      // scroll-up pass its own reachability test.
      const result = await collectOlderPage({
        startSeq: logSeq,
        estimateBytes: estimateMessageBytes,
        fetchChunk: (before) => new Promise((resolve) => {
          let settled = false;
          const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
          const timer = setTimeout(() => done(null), HISTORY_TIMEOUT_MS);
          b.emit("aiHistory", { sessionId, before }, done);
        }),
        reduceChunk: (events, held) => {
          const curr = useAiStore.getState().bySession[sessionId];
          return reduceSessionEvents(events, engine, (curr?.messages?.length || 0) + held + 1).messages;
        }
      });
      const { messages: older, before, hasMore, answered, chunks } = result;
      // TEMP DIAGNOSTIC — the host side of the scroll-up fetch. A null ack means nobody
      // answered (carrier or route), success:false means the host had nothing to give.
      // Remove once paging is confirmed end to end.
      termLog("ai-page", "loadOlder", {
        sessionId, before: logSeq, ms: Date.now() - t0, transport: b.transport || b.carrier || "?",
        chunks, messages: older.length,
        bytes: Math.round(older.reduce((n, m) => n + estimateMessageBytes(m), 0) / 1024) + "KB",
        hasMore
      });
      // The log changed under this fetch. Its turns belong to a conversation that is no
      // longer shown — dropping them here also keeps the marks below untouched, or the
      // fetch would report progress it never made and stall the paging for good.
      if (olderSeqRef.current !== logSeq) return false;
      if (!answered) return false;
      olderSeqRef.current = before;
      setHasOlder(hasMore);
      if (!older.length) return false;
      useAiStore.getState().prependMessages(sessionId, older);
      return true;
    } finally {
      loadingOlderRef.current = false;
    }
  }, [sessionId, engine]);

  return {
    hydrating,
    synced,
    hydrateFailed,
    hasOlder,
    loadOlder,
    // Re-pull the host's log for this session. Mount, resume and reconnect call it
    // on their own; the pane's refresh button is the manual one for when a run of
    // events was lost while the carrier was up.
    reload: retryNow,
    sendPrompt,
    removeQueueItem,
    clearQueue,
    resolvePermission,
    stop,
    stopTask,
    runShell,
    rewindToMessage,
    previewRewind,
    listRewindPoints,
    escalateMode,
    dismissBlocked
  };
}
