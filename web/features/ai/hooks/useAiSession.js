"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { useAiStore } from "@/shared/stores/aiStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { connForSession } from "@/shared/transport/hostConn";
import { parseEngineTaskEvent, parseEngineTaskResult, getEngineConfig } from "../registry";
import { updateToolTree, settleRunningTools } from "../lib/toolTree";
import { applyTaskRecord, foldTaskRecords, noticeFrom, lastIndexOfCompacting, TASK_ENDED } from "../lib/harnessTasks";
import { upsertTask } from "../lib/taskList";
import { estimateMessageBytes } from "../lib/messageWindow";
import { collectOlderPage } from "../lib/olderPaging";
import { createRetryLadder, shouldApplyHydrateAck } from "../lib/hydrateRetry";
import { classifyLiveEvent, fetchedIsSafe, splitByHole } from "../lib/gapFill";
import { createSingleLane } from "../lib/singleLane";
import { AI_CACHE_MAX_BYTES, appendTail, buildCacheEntry, cacheKey, shouldUseCachedSnapshot, trimTail } from "../lib/aiCache";
import { aiCacheEnabled, readAiCache, writeAiCache } from "../lib/aiCacheStore";
import { termLog } from "@/shared/utils/termLog";
import { PEEK_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";
import { RESOLVE_ACK_TIMEOUT_MS, PROMPT_ACK_TIMEOUT_MS, PROMPT_ECHO_TIMEOUT_MS } from "../constants";
import { emitPromptAck } from "../lib/promptAck";
import { createEchoWatchdog } from "../lib/echoWatchdog";
import { rememberPrompt } from "../lib/promptHistory";
import { addPending, removePending, removePendingByText, takeOrphans } from "../lib/pendingPrompts";

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
// Fetch-the-hole budget; an older host without the handler never answers it.
const GAP_FETCH_TIMEOUT_MS = 3000;
// A quiet running turn is probed after this much silence, backing off to the cap while quiet.
const SILENCE_PEEK_FIRST_MS = 10_000;
const SILENCE_PEEK_MAX_MS = 120_000;
// A gap must survive a re-probe before acting — an event still in flight can mimic one.
const GAP_CONFIRM_MS = 1500;
// Events held while a hole is fetched; past this the pane resyncs whole instead.
const MAX_GAP_HELD = 200;
// A finished turn settles before its tail is written — a turn that keeps going writes nothing.
const CACHE_WRITE_DEBOUNCE_MS = 800;
// Automatic resends after a reconnect — past this the manual bar is the only road.
const PROMPT_AUTO_RETRY_MAX = 2;
// This page life — a pending prompt stamped with it is in flight here, not an orphan.
const PAGE_ID = Math.random().toString(36).slice(2, 10);

// The CLI reports some failures twice (streamed prose + `result`); only the last message is checked to stay cheap.
function alreadySaid(messages, text) {
  const said = String(text || "").trim();
  if (!said) return false;
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === "assistant" && String(last.content || "").trim().endsWith(said));
}

// The turn settled on an assistant row with nothing in it: the pane missed the whole
// answer, and only the host's log can put it back.
function emptyAnswerRow(messages) {
  const last = messages?.[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return !last.content && !last.thinking && !(last.tools?.length) && !(last.diffs?.length);
}

// Escape codes a raw CLI line carries — the row shows the text between them, not the codes.
const ANSI_CODES_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ansiText = (chunk) => String(chunk || "").replace(ANSI_CODES_RE, "").trim();

/** The failure already drew its own row (an `error` event) — a turn_complete with no sentence of its own adds only a duplicate. */
const failureAlreadyDrew = (messages, text) => {
  if (String(text || "").trim()) return false;
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === "notice" && last.level === "error");
};

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
  // The log saw the CLI process die; a later prompt means one answered since.
  let processDied = false;
  let msgSeq = idBase;

  for (const item of events) {
    const event = item?.event;
    const data = item?.data;
    if (!event) continue;

    switch (event) {
      case "user_message": {
        isTurnRunning = true;
        processDied = false;
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
        processDied = false;
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
      // The CLI reset its conversation; the reset itself arrives as conversation_reset
      // plus the fresh init that follows — this frame carries no replay payload of its own.
      case "cli_reset":
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
        // A failed turn draws the CLI's own sentence; alreadySaid guards its double report,
        // and an error row that just landed says everything a sentence-less one would.
        if (data?.isError && !failureAlreadyDrew(messages, data.result) && !alreadySaid(messages, data.result)) {
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
        processDied = true;
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
        processDied = false;
        activePermission = null;
        activeBlocked = null;
        break;
      // Records with no card yet are kept, not dropped — the pane may learn to draw them.
      case "cli_event": {
        const type = data?.type || "";
        const record = data?.record || null;
        harnessRecords.push([type, data?.subtype || "", record, data?.ageMs]);
        const notice = noticeFrom(type, record, engine);
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
      case "ansi": {
        // Raw CLI output the JSON parsers could not read — a crash trace, a banner, or
        // the host's own "output lost while the agent restarted" line. Prose, not codes.
        const chunk = ansiText(data?.chunk);
        if (!chunk) break;
        // Same rule as the cli_event path beside this: drop the empty placeholder so the
        // row does not leave a bare bubble behind it.
        const last = messages[messages.length - 1];
        if (last && last.role === "assistant" && !last.content && !last.thinking && !(last.tools || []).length) {
          messages.pop();
        }
        messages.push({ id: `n-${++msgSeq}`, role: "notice", subtype: "ansi", level: "warning", content: chunk });
        break;
      }
      default:
        break;
    }
  }

  // Keyed on turnEnded, not isTurnRunning: a reduced older page carries no end event.
  // A dead process also takes the async rows — nothing is left to answer for them.
  if (turnEnded || processDied) {
    for (const m of messages) if (m.tools) m.tools = settleRunningTools(m.tools, { includeAsync: processDied });
  }

  let harnessTasks = [];
  for (const [type, subtype, record] of harnessRecords) harnessTasks = applyTaskRecord(harnessTasks, type, subtype, record);
  // A process that died settles everything it left running — the CLI that would report
  // each end is gone, so the fold's last word is already final.
  if (processDied) {
    harnessTasks = harnessTasks.map((t) =>
      TASK_ENDED.has(t.status) ? t : { ...t, status: "stopped", endedAt: t.endedAt || Date.now() }
    );
  }

  return {
    messages, tasks, metadata, stats, isTurnRunning, activePermission, activeBlocked, permissionMode,
    harnessRecords,
    harnessTasks
  };
}

// The echo lands in the store before the ack's own window closes, so a timeout that
// fires afterwards is not evidence of loss. Without this check the late "lost" entry
// was never cleared by anything (its echo had already gone by) and every reconnect
// auto-resent it as a NEW turn — the same words, over and over.
function promptAlreadyShown(sid, text) {
  if (!text) return false;
  const messages = useAiStore.getState().bySession[sid]?.messages || [];
  // Only the NEWEST user bubble counts: an older identical prompt is not evidence —
  // "tiếp" is asked again all the time, and a genuinely lost one must stay recoverable.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return false;
  // A merged loss appends, so the newest echo is the tail of the blob.
  return lastUser.content === text || String(text).endsWith("\n\n" + lastUser.content);
}

// A reload between send and ack: offer back what the replayed log does not show as delivered.
function surfaceOrphanPrompts(sid, events) {
  const deliveredTexts = (events || []).filter((e) => e.event === "user_message").map((e) => e.data?.text);
  const orphans = takeOrphans(sid, { deliveredTexts, page: PAGE_ID, minAgeMs: PROMPT_ACK_TIMEOUT_MS })
    .filter((p) => !promptAlreadyShown(sid, p.text));
  for (const p of orphans) useAiStore.getState().setPromptError(sid, p.text, "reload", null, p.id);
}

// The host echoed a prompt the composer reported lost — drop that part, keep any other.
// The match may sit anywhere in the merged text: a middle segment left behind kept the
// whole blob "lost" forever, and the next reconnect sent it again.
function clearEchoedPromptError(sid, echoed) {
  const lost = useAiStore.getState().bySession[sid]?.promptError;
  if (!lost || !echoed) return;
  if (lost.text === echoed) { useAiStore.getState().clearPromptError(sid); return; }
  const parts = lost.text.split("\n\n");
  const at = parts.indexOf(echoed);
  if (at === -1) return;
  parts.splice(at, 1);
  const rest = parts.filter(Boolean).join("\n\n");
  if (rest) useAiStore.getState().setPromptErrorText(sid, rest);
  else useAiStore.getState().clearPromptError(sid);
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
  const ensureTurnLive = useAiStore((s) => s.ensureTurnLive);
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
  // Echo watchdogs keyed by prompt id — an acked prompt with no user_message back
  // must surface as resendable instead of leaving the chat blank.
  const echoWatchRef = useRef(new Map());
  const settleEchoWatch = useCallback((text) => {
    const map = echoWatchRef.current;
    if (!map.size) return;
    for (const [id, entry] of map) {
      if (entry.text !== text) continue;
      entry.watch.settle();
      map.delete(id);
    }
  }, []);

  // Dispatch-only by design: subscribing here would rebuild the hook per streamed frame.

  // One door for live and replay alike: the host is the source of truth.
  const applyEvent = useCallback((sid, event, data) => {
    switch (event) {
      case "user_message":
        // `replay` marks a re-sent log: the prompt already happened, so it opens no turn.
        addUserMessage(sid, data.text, data.attachments || null, Boolean(data?.replay));
        if (!data?.replay) {
          removePendingByText(sid, data.text);
          useAiStore.getState().clearPromptSending(sid, data.text);
        }
        // Echo of a prompt the composer reported lost — the host did get it.
        clearEchoedPromptError(sid, data.text);
        settleEchoWatch(data?.text);
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
        // Stream proof — same law the host adapter holds ("output proves a turn"):
        // a live delta after a flag-clearing race means the turn never ended.
        if (!data?.replay) ensureTurnLive(sid);
        appendDelta(sid, data.text);
        break;
      case "thinking":
        if (!data?.replay) ensureTurnLive(sid);
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
        if (!data?.replay) ensureTurnLive(sid);
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
        // A settled turn that leaves an empty answer row is the pane having missed the
        // whole stream (a dropped carrier, a window that opened past it): the log is at
        // the host, so pull it once instead of waiting for the next prompt to heal it.
        if (!data?.replay && emptyAnswerRow(useAiStore.getState().bySession[sid]?.messages)) {
          termLog("ai-hydrate", "settled with an empty answer → hydrate", { sessionId: sid });
          laneRef.current?.request("hydrate");
        }
        // A failed turn draws the CLI's own sentence, rebuilt on replay too; alreadySaid guards the double report.
        if (data?.isError && !failureAlreadyDrew(useAiStore.getState().bySession[sid]?.messages, data.result) && !alreadySaid(useAiStore.getState().bySession[sid]?.messages, data.result)) {
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
        // `stopped` only interrupts the turn — the CLI lives on and its background work
        // with it. `exit` took the process, so everything it launched died with it.
        if (event === "exit") useAiStore.getState().settleDeadTasks(sid);
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
        const notice = noticeFrom(type, record, engine);
        if (notice) useAiStore.getState().addNotice(sid, notice);
        break;
      }
      case "ansi": {
        // Same row the replay draws: raw CLI output no parser could read.
        const chunk = ansiText(data?.chunk);
        if (chunk) useAiStore.getState().addNotice(sid, { subtype: "ansi", level: "warning", content: chunk });
        break;
      }
      default:
        break;
    }
  }, [engine, addUserMessage, setMetadata, appendDelta, appendThinking, appendDiff, appendTool, updateToolResult, nestTool, nestToolResult, upsertTask, setPermission, clearPermission, finishTurn, setTurnRunning, ensureTurnLive, settleEchoWatch]);

  // Ref, not dep: the hydrate effect must not re-emit ai:create over a mid-stream session.
  const applyEventRef = useRef(applyEvent);
  useEffect(() => { applyEventRef.current = applyEvent; });

  // Same reason as applyEvent: key on session identity, not action identity.
  const initSessionRef = useRef(initSession);
  useEffect(() => { initSessionRef.current = initSession; });

  // Highest host seq applied; events at or below it must not be applied twice.
  const appliedSeqRef = useRef(0);
  // The host's log generation (null until an ack or stamped event sets it); seqs from
  // another generation must read as neither newer nor already-applied.
  const logEpochRef = useRef(null);
  // Live events held during a hydrate — the ack's replay would wipe anything applied now.
  const hydratingRef = useRef(false);
  const pendingLiveRef = useRef([]);
  // Bumped per attempt; a stale StrictMode ack must not release a newer cycle's gate.
  const hydrateSeqRef = useRef(0);
  // Re-ask ladder; delays live in lib/hydrateRetry — the delay is handed to the lane.
  const ladderRef = useRef(null);
  if (ladderRef.current == null) ladderRef.current = createRetryLadder();
  const lastHydrateOkAtRef = useRef(0);
  const releaseTimerRef = useRef(null);
  // One lane for every recovery ask (probe / gap fill / hydrate): one debounce, one
  // in-flight round, one coalesced pending intent. The law lives in lib/singleLane.
  const laneRef = useRef(null);
  // Runners reached through refs so the lane never holds a stale closure.
  const hydrateNowRef = useRef(null);
  const runProbeRef = useRef(null);
  // The gap runner lives inside the events effect (it needs applyLive's stream buffer).
  const gapRunnerRef = useRef(null);
  const gapTimerRef = useRef(null);
  // Auto-resend reaches back into sendPrompt, which is defined below the effects.
  // Auto-resend reaches back into sendPrompt, which is defined below the effects.
  const autoResendRef = useRef(null);
  // Session that last owned the gate; a late workspacePath re-run must not reopen it.
  const gateSessionRef = useRef(null);

  const isVisibleRef = useRef(isVisible);
  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  const pendingRecoverRef = useRef(null);
  const peekDeadlineRef = useRef(null);

  // Gap-fill: events held while the missing range is fetched.
  const gapHeldRef = useRef([]);
  // Best-effort replay tail kept in IndexedDB (lib/aiCache). Never authoritative:
  // it only paints while the host hydrate is on its way, and is replaced by its ack.
  const tailRef = useRef({ events: [], bytes: 0, hasMore: false });
  const cacheWriteTimerRef = useRef(null);
  const cacheLoadSessionRef = useRef(null);
  // Silence probe: last inbound ai:event, the silence threshold (backs off while quiet),
  // its in-flight flag, consecutive misses, and when the user last sent a prompt.
  const lastEventAtRef = useRef(0);
  const silenceNeedRef = useRef(SILENCE_PEEK_FIRST_MS);
  const probeBusyRef = useRef(false);
  const peekMissRef = useRef(0);
  const promptSentAtRef = useRef(0);

  const clearHydrateRetry = useCallback(() => {
    ladderRef.current?.answered();
    // Only the rung: a gap ask that arrived meanwhile is a different piece of work.
    laneRef.current?.clearPending("hydrate");
  }, []);

  // A failed round hands the ladder's delay to the lane — one timer, no stacked rounds.
  const scheduleHydrateRetry = useCallback(() => {
    const delay = ladderRef.current?.schedule(useConnectionStore.getState().connected);
    // A null delay means offline or a rung already armed — neither is a failure.
    setHydrateFailed(Boolean(ladderRef.current?.exhausted()));
    termLog("ai-hydrate", "ladder", {
      delay: delay ?? null, exhausted: ladderRef.current?.exhausted(),
      connected: useConnectionStore.getState().connected
    });
    if (delay != null) laneRef.current?.request("hydrate", { delayMs: delay });
  }, []);

  // The lane is built once per mount; every runner is reached through a ref, never a closure.
  useEffect(() => {
    laneRef.current = createSingleLane({
      run: (intent, done) => {
        // A runner that is not wired yet must still settle, or the lane jams forever.
        if (intent === "recover") {
          if (runProbeRef.current) runProbeRef.current(done);
          else done();
          return;
        }
        if (intent === "gap") {
          if (gapRunnerRef.current) gapRunnerRef.current(done);
          else { laneRef.current?.request("hydrate"); done(); }
          return;
        }
        // hydrate | now — the mount path calls hydrateNow directly, so the blocked
        // branch inside settles the lane and re-arms through the ladder.
        ladderRef.current?.fired();
        if (hydrateNowRef.current) hydrateNowRef.current(done);
        else done();
      }
    });
  }, []);

  // 1. Pull the host's log: truncate then replay — also the only path back after a carrier drop.
  // `onSettled` is the lane's done: exactly one call per round, on ack or on release.

  // ── Best-effort replay cache (never authoritative) ───────────────────────────

  // Record what the pane applied so a turn_complete can persist a bounded tail.
  const noteTail = useCallback((seq, event, data) => {
    if (event === "conversation_reset") { tailRef.current = { events: [], bytes: 0, hasMore: false }; return; }
    if (!Number.isInteger(seq)) return;
    const next = appendTail(tailRef.current, { seq, event, data }, AI_CACHE_MAX_BYTES);
    tailRef.current = {
      events: next.events,
      bytes: next.bytes,
      hasMore: tailRef.current.hasMore || next.dropped
    };
  }, []);

  // A hydrate ack states the log's own tail — it supersedes anything we appended.
  const setTailFromAck = useCallback((events, hostHasMore) => {
    const tail = trimTail(events || [], AI_CACHE_MAX_BYTES);
    tailRef.current = {
      events: tail.events,
      bytes: tail.bytes,
      hasMore: Boolean(hostHasMore) || tail.hasMore
    };
  }, []);

  const writeCacheNow = useCallback(() => {
    if (!aiCacheEnabled() || !sessionId) return;
    // A running turn would cache half a sentence; the next settled tail supersedes it.
    if (useAiStore.getState().bySession[sessionId]?.isTurnRunning) return;
    const hostKey = connForSession(sessionId).head || "";
    const entry = buildCacheEntry({
      hostKey,
      sessionId,
      epoch: logEpochRef.current,
      tail: tailRef.current,
      lastTurnMs: useAiStore.getState().bySession[sessionId]?.lastTurnMs || 0
    });
    if (entry) writeAiCache(cacheKey(hostKey, sessionId), entry);
  }, [sessionId]);

  // A finished turn is a settled tail; a running one would cache half a sentence.
  const scheduleCacheWrite = useCallback(() => {
    if (!aiCacheEnabled() || !sessionId) return;
    if (cacheWriteTimerRef.current) clearTimeout(cacheWriteTimerRef.current);
    cacheWriteTimerRef.current = setTimeout(() => {
      cacheWriteTimerRef.current = null;
      writeCacheNow();
    }, CACHE_WRITE_DEBOUNCE_MS);
  }, [sessionId, writeCacheNow]);

  // Paint the cached tail only while the pane is otherwise empty and unanswered.
  const loadCachedTail = useCallback(() => {
    if (!aiCacheEnabled() || !sessionId) return;
    if (cacheLoadSessionRef.current === sessionId) return;
    cacheLoadSessionRef.current = sessionId;
    const hostKey = connForSession(sessionId).head || "";
    readAiCache(cacheKey(hostKey, sessionId)).then((raw) => {
      // The pane moved to another session while the read was in flight.
      if (cacheLoadSessionRef.current !== sessionId) return;
      if (!shouldUseCachedSnapshot(raw, { hostKey, sessionId })) return;
      // The host answered meanwhile — its replay is the truth, the cache is not needed.
      if (lastHydrateOkAtRef.current) return;
      const curr = useAiStore.getState().bySession[sessionId];
      if (curr?.messages?.length) return;
      const hydrated = reduceSessionEvents(raw.events, engine);
      if (!hydrated.messages?.length) return;
      useAiStore.getState().hydrateSession(sessionId, {
        messages: hydrated.messages,
        tasks: hydrated.tasks,
        metadata: { ...(curr?.metadata || {}), ...hydrated.metadata },
        stats: hydrated.stats,
        isTurnRunning: false,
        elapsedMs: 0,
        lastTurnMs: raw.lastTurnMs || 0,
        harnessTasks: hydrated.harnessTasks,
        queue: []
      });
      appliedSeqRef.current = raw.seq;
      logEpochRef.current = raw.epoch;
      olderSeqRef.current = raw.firstSeq;
      setHasOlder(Boolean(raw.hasMore));
      const tail = trimTail(raw.events, AI_CACHE_MAX_BYTES);
      tailRef.current = { events: tail.events, bytes: tail.bytes, hasMore: Boolean(raw.hasMore) || tail.hasMore };
      termLog("ai-cache", "painted cached tail", { sessionId, seq: raw.seq, epoch: raw.epoch, events: raw.events.length });
    }).catch(() => {});
  }, [sessionId, engine]);

  const hydrateNow = useCallback((onSettled = null) => {
    if (!sessionId || !bus) { onSettled?.(); return; }
    // One round at a time; a mid-round request arms the ladder instead.
    if (hydratingRef.current) {
      termLog("ai-hydrate", "blocked (round in flight)", { gen: hydrateSeqRef.current });
      scheduleHydrateRetry();
      onSettled?.();
      return;
    }
    const gen = ++hydrateSeqRef.current;
    // Which log this round asks about — see logEpochRef. Bumped by a reset while it flies.
    const epoch = logEpochRef.current;
    hydratingRef.current = true;
    setHydrating(true);
    pendingLiveRef.current = [];
    // A fresh replay supersedes any patch in flight; its events arrive held above.
    gapHeldRef.current = [];
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
      // Same law as the live path: a hole is held and fetched, never walked over.
      const plan = splitByHole(queued, { appliedSeq: appliedSeqRef.current, logEpoch: logEpochRef.current });
      appliedSeqRef.current = plan.appliedSeq;
      logEpochRef.current = plan.logEpoch;
      unstable_batchedUpdates(() => {
        for (const p of plan.apply) {
          // The reset's counters are already folded into the plan; only the window rides here.
          if (p.event === "conversation_reset") {
            olderSeqRef.current = p.data?.fromSeq ?? 0;
            setHasOlder(Boolean(p.data?.hasMore));
          }
          applyEventRef.current(sessionId, p.event, p.data);
          noteTail(p.seq, p.event, p.data);
        }
      });
      if (plan.resync) { laneRef.current?.request("hydrate"); return; }
      if (plan.held.length > MAX_GAP_HELD) { laneRef.current?.request("hydrate"); return; }
      if (plan.held.length) {
        gapHeldRef.current = [...gapHeldRef.current, ...plan.held];
        laneRef.current?.request("gap");
      }
    };
    // A lost ack must not shut the gate forever; past this window the snapshot is stale.
    const releaseTimer = setTimeout(() => {
      if (gen !== hydrateSeqRef.current || !hydratingRef.current) return;
      releaseHeld();
      // An unanswered round proves the carrier silent — re-dial before the next rung.
      bus.kickWsZombie?.("hydrate-timeout");
      // Nobody answered — the pane would hold a partial view with no way to page back.
      scheduleHydrateRetry();
      onSettled?.();
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
      })) { onSettled?.(); return; }
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
        // A resting pane rehydrates as resting — the dot says sleep until the next
        // prompt (whose user_message moves it to working through the bus).
        if (res.session.asleep && !res.session.isTurnRunning) {
          const fleet = useFleetStore.getState();
          fleet.applyStatusChange(connForSession(sessionId).head ?? fleet.currentKey, { sessionId, state: "sleep" });
        }
        // The host replays only the tail of a long log; the rest is fetched on scroll-up.
        olderSeqRef.current = events[0]?.seq ?? 0;
        setHasOlder(Boolean(res.session.hasMore) && events.length > 0);
        // The ack's window is the tail the cache should hold from here on.
        setTailFromAck(events, res.session.hasMore);
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
        // A resting pane is a dead process (idle-killed): the tasks its log left
        // "running" ended with it and nothing alive will send their end — settle or the
        // strip pins them forever after a reload.
        if (res.session.asleep && !res.session.isTurnRunning) {
          useAiStore.getState().settleDeadTasks(sessionId);
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
        // Same for the generation — the watermark above is only valid inside it.
        if (res.session.epoch != null) logEpochRef.current = res.session.epoch;
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
        }
        // Only a real answer stands the ladder down. A rejected ack (`rtc-closed` is how
        // the carrier reports a dead RTC) means the host was never reached, so the rung
        // armed while this round was in flight keeps its timer — and one that was never
        // armed is armed now, or that dropped frame costs the pane its history for good.
        if (res?.ok) {
          setSynced(true); setHydrateFailed(false); clearHydrateRetry();
          lastHydrateOkAtRef.current = Date.now();
          surfaceOrphanPrompts(sessionId, res.session?.events);
        }
        else scheduleHydrateRetry();
        onSettled?.();
      }
    });
  }, [sessionId, engine, workspacePath, bus, setTurnRunning, scheduleHydrateRetry, clearHydrateRetry, noteTail, setTailFromAck]);

  // The one door for every cheap trigger (visibility, resume, connect). A repair asked
  // for by a live verdict (epoch/gap) goes straight to the lane, past this door.
  const requestRecover = useCallback(() => {
    // Offline, the send would sit in the carrier's buffer to be answered by a host that
    // has moved on — the bus "connect" trigger asks again once there is someone to ask.
    if (!useConnectionStore.getState().connected) return;
    // Always the probe: it compares watermarks, patches a gap in place and escalates to a
    // full hydrate only when the log really moved. Hydrating here replayed a tail that
    // replaced the pages the reader had loaded, so every resume wiped the chat.
    laneRef.current?.request("recover");
  }, []);

  // The lane's probe runner: check where the host is before pulling anything.
  const runProbe = useCallback((done) => {
    const b = busRef.current;
    if (!b || !sessionId) { done(); return; }
    if (!isVisibleRef.current) { pendingRecoverRef.current = "visible"; done(); return; }
    if (!useConnectionStore.getState().connected) { done(); return; }
    // A hydrate in flight will replay whatever the probe would find — let it answer.
    if (hydratingRef.current) { done(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; done(); } };
    // A peek nobody answers (an older agent without the handler, or every carrier
    // zombie on a mobile resume) must not leave the pane stale: fall back to the
    // full hydrate, whose own ladder keeps re-asking. A late ack after the deadline
    // still runs its comparison — the lane coalesces the two asks into one round.
    let answered = false;
    const deadline = setTimeout(() => {
      if (answered) return;
      termLog("ai-hydrate", "peekSeq: no ack → full hydrate");
      // No ack for a full timeout: the ask may sit in a zombie WS — re-dial first.
      b.kickWsZombie?.("peek-timeout");
      laneRef.current?.request("hydrate");
      finish();
    }, PEEK_TIMEOUT_MS);
    peekDeadlineRef.current = deadline;
    b.emit("ai:peekSeq", { sessionId, haveSeq: appliedSeqRef.current, epoch: logEpochRef.current }, (res) => {
      answered = true;
      clearTimeout(deadline);
      peekDeadlineRef.current = null;
      if (!res?.ok || typeof res.seq !== "number") {
        laneRef.current?.request("hydrate");
        finish();
        return;
      }
      const lastSeq = appliedSeqRef.current;
      const currentTurnRunning = Boolean(useAiStore.getState().bySession[sessionId]?.isTurnRunning);
      const currentQueueLen = useAiStore.getState().bySession[sessionId]?.queue?.length || 0;
      const hostQueueLen = typeof res.queueLength === "number" ? res.queueLength : currentQueueLen;
      if (res.seq === lastSeq && Boolean(res.isTurnRunning) === currentTurnRunning && hostQueueLen === currentQueueLen) {
        termLog("ai-hydrate", "peekSeq: nothing missed", { seq: lastSeq });
        finish();
        return;
      }
      // Watermark known to be the same log: nothing structural changed. Behind on it
      // (a mobile sleep that lost the streaming tail) → patch the missing range in
      // place. The destructive replay here is what wiped the older pages the reader
      // had scrolled up to load and snapped the view to the tail on every resume.
      const sameLog = res.epoch != null && res.epoch === logEpochRef.current;
      if (res.seq > lastSeq && sameLog) { laneRef.current?.request("gap"); finish(); return; }
      // Flag-only drift with the watermark in sync: no events were lost — patch the
      // flag, keep the view exactly where it is.
      if (res.seq === lastSeq && sameLog && hostQueueLen === currentQueueLen) {
        termLog("ai-hydrate", "peekSeq: turn-flag drift patched in place", { seq: lastSeq, turn: res.isTurnRunning });
        useAiStore.getState().setTurnRunning(sessionId, Boolean(res.isTurnRunning));
        finish();
        return;
      }
      termLog("ai-hydrate", "peekSeq: state changed", { fromSeq: lastSeq, toSeq: res.seq, turn: res.isTurnRunning });
      laneRef.current?.request("hydrate");
      finish();
    });
  }, [sessionId]);

  // Runners reach the lane through refs — the lane is built once, above.
  useEffect(() => {
    hydrateNowRef.current = hydrateNow;
    runProbeRef.current = runProbe;
  });

  // A tap is the user saying "now": re-dial a zombie carrier and ask past the debounce.
  const retryNow = useCallback(() => {
    bus?.kickWsZombie?.("refresh");
    clearHydrateRetry();
    laneRef.current?.request("now", { immediate: true });
  }, [bus, clearHydrateRetry]);

  // Leaving the session stops every timer that could emit for it, and drops the gate. Both
  // matter for a StrictMode remount, where the refs survive: the ack of a round in flight
  // is cancelled by this cleanup, so without the flag being cleared the next mount would
  // find the gate shut and buffer every live event forever.
  useEffect(() => () => {
    if (peekDeadlineRef.current) clearTimeout(peekDeadlineRef.current);
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    if (gapTimerRef.current) clearTimeout(gapTimerRef.current);
    peekDeadlineRef.current = releaseTimerRef.current = gapTimerRef.current = null;
    // Reset, then stub: an in-flight ack settling after unmount must not arm new
    // rounds for a pane that no longer exists (a remount builds its own lane).
    laneRef.current?.reset();
    laneRef.current = { request() {}, busy() { return false; }, clearPending() {}, reset() {} };
    hydratingRef.current = false;
    pendingLiveRef.current = [];
    for (const { watch } of echoWatchRef.current.values()) watch.settle();
    echoWatchRef.current.clear();
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
      // Its watermark/generation and probe clocks belong to the previous chat.
      logEpochRef.current = null;
      gapHeldRef.current = [];
      laneRef.current?.reset();
      lastEventAtRef.current = 0;
      peekMissRef.current = 0;
      promptSentAtRef.current = 0;
    }
    // Held in a ref: re-running this effect on a store-action identity change would
    // re-emit ai:create over a session that is mid-stream.
    initSessionRef.current(sessionId);
    // Paint the cached tail while the host replay is on its way; the ack replaces it.
    loadCachedTail();
    // Straight at the host, NOT through the lane: on a cold start no carrier is
    // ready yet and that door would drop the ask, while the carrier's "connect" only
    // fires on LATER rejoins — the pane would sit empty over a healthy host until the
    // user hit refresh. PM buffers the emit and flushes it on the first adapter, which
    // is the behavior this mount has always relied on. A rejoin landing in the same
    // breath is then held off by the in-flight gate above, not by a delay.
    return hydrateNow();
  }, [sessionId, hydrateNow, clearHydrateRetry, loadCachedTail]);

  // Resume recovery and visibility: only check seq if visible; hidden panes defer.
  useEffect(() => {
    if (!isVisible) return;
    const pending = pendingRecoverRef.current;
    if (!pending) return;
    pendingRecoverRef.current = null;
    requestRecover();
  }, [isVisible, requestRecover]);

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
      if (!document.hidden) requestRecover();
    };
    // Expo WebView never flips document.hidden — the shell's native event is the resume signal there.
    const onAppVisible = (e) => {
      if (!e.detail?.hidden) requestRecover();
    };
    const onConnect = () => {
      autoResendRef.current?.(); // offline-lost prompts go out the moment a carrier is back
      if (!isVisibleRef.current) {
        pendingRecoverRef.current = "reconnect";
        return;
      }
      requestRecover();
    };
    // Page Lifecycle `resume`: Chrome Android wakes a frozen tab without firing a
    // visibilitychange (the same gap pmWatchers covers on the transport side). bfcache
    // restores need nothing extra — those do fire visibilitychange.
    bus.on("connect", onConnect);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("resume", onVisible);
    document.addEventListener("app-visibility", onAppVisible);
    return () => {
      bus.off("connect", onConnect);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onVisible);
      document.removeEventListener("app-visibility", onAppVisible);
    };
  }, [bus, sessionId, requestRecover]);

  // The carrier coming back is a trigger in its own right, not just a prelude to the
  // bus "connect" above. That event only fires on a rejoin the PM judges worthwhile
  // (_maybeFireRejoin), and it stays silent whenever the OTHER carrier is still ready —
  // so the case this covers is a phone that slept through a full outage: the resume fires
  // while both carriers are dead, the trigger ask is dropped, and the carriers then
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
      autoResendRef.current?.();
      if (!isVisibleRef.current) {
        pendingRecoverRef.current = "reconnect";
        return;
      }
      requestRecover();
    }
  }, [connected, requestRecover]);

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
      unstable_batchedUpdates(() => {
        for (const item of batch) {
          if (item.stream) useAiStore.getState().appendStream(sessionId, item.data.text, item.data.thinking);
          else apply(sessionId, item.event, item.data);
        }
      });
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
      // Any inbound proves the carrier delivers — reset the silence probe's clock.
      lastEventAtRef.current = Date.now();
      silenceNeedRef.current = SILENCE_PEEK_FIRST_MS;
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
        logEpochRef.current = payload.data?.epoch ?? (logEpochRef.current ?? 0) + 1;
        // The window belongs to the log that just ended. Keeping it would make the next
        // scroll-up fetch seqs the fresh log already replays — every turn rendered twice.
        // The host replays a tail only, so the reset states where that tail starts.
        olderSeqRef.current = payload.data?.fromSeq ?? 0;
        setHasOlder(Boolean(payload.data?.hasMore));
        gapHeldRef.current = [];
        noteTail(null, "conversation_reset", null);
        queueEvent(payload.event, payload.data);
        return;
      }
      // One door for every live verdict — dedupe, generation, hole. Pinned in
      // lib/gapFill; the seqDedupe law it embeds is the one the replay relied on.
      const verdict = classifyLiveEvent(payload, { appliedSeq: appliedSeqRef.current, logEpoch: logEpochRef.current });
      if (verdict === "adopt") logEpochRef.current = payload.epoch;
      else if (verdict === "resync") {
        // A newer log generation whose reset never arrived: the watermark now swallows
        // every live event. Only a full pull re-establishes the truth.
        gapHeldRef.current = [];
        laneRef.current?.request("hydrate");
        return;
      } else if (verdict === "stale" || verdict === "dup") return;
      else if (verdict === "gap") {
        // A recorded event went missing; hold everything past the hole and fetch it.
        gapHeldRef.current.push(payload);
        if (gapHeldRef.current.length > MAX_GAP_HELD) {
          gapHeldRef.current = [];
          laneRef.current?.request("hydrate");
          return;
        }
        laneRef.current?.request("gap");
        return;
      }
      if (payload.seq != null) appliedSeqRef.current = payload.seq;
      noteTail(payload.seq, payload.event, payload.data);
      // A finished turn is a settled tail; anything else would cache half a sentence.
      if (payload.event === "turn_complete") scheduleCacheWrite();
      applyLive(payload.event, payload.data);
    };

    // Anything below either changes what the pane may do, or restarts the log the
    // buffered text belongs to — queueEvent folds that text in ahead of the event it
    // preceded, so the order the reader sees is still the order the host sent.
    function applyLive(event, data) {
      if (event === "delta" || event === "thinking") {
        bufferStream(event, data?.text);
        return;
      }
      queueEvent(event, data);
    }

    // Events that arrived while the hole was being filled, re-checked by the shared
    // drain law; a hole that persists asks for the range again (bounded by MAX_GAP_HELD).
    const drainGapHeld = () => {
      const held = gapHeldRef.current;
      gapHeldRef.current = [];
      const plan = splitByHole(held, { appliedSeq: appliedSeqRef.current, logEpoch: logEpochRef.current });
      if (plan.resync) { laneRef.current?.request("hydrate"); return; }
      appliedSeqRef.current = plan.appliedSeq;
      logEpochRef.current = plan.logEpoch;
      for (const p of plan.apply) { applyLive(p.event, p.data); noteTail(p.seq, p.event, p.data); }
      if (plan.held.length) {
        gapHeldRef.current = plan.held;
        laneRef.current?.request("gap");
      }
    };

    // The lane's gap runner: fetch the missing range and splice it in. Anything the
    // fetch cannot make safe — an older host (timeout), another generation, a gap past
    // the byte cap, or a compacted stream record overlapping applied text — resyncs
    // whole instead.
    const runGapFetch = (done) => {
      if (hydratingRef.current) { done(); return; }
      const b = busRef.current;
      if (!b || !useConnectionStore.getState().connected) { done(); return; }
      const after = appliedSeqRef.current;
      const epoch = logEpochRef.current;
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        gapTimerRef.current = null;
        // A hydrate that started meanwhile supersedes any patch.
        if (hydratingRef.current) { done(); return; }
        const plan = fetchedIsSafe(res?.ok ? res.events || [] : [], appliedSeqRef.current);
        if (!res?.ok || res.resync || res.epoch !== epoch || res.hasMore || !plan.safe) {
          gapHeldRef.current = [];
          laneRef.current?.request("hydrate");
          done();
          return;
        }
        for (const ev of plan.apply) {
          appliedSeqRef.current = ev.seq;
          applyLive(ev.event, ev.data);
          noteTail(ev.seq, ev.event, ev.data);
        }
        drainGapHeld();
        done();
      };
      const timer = setTimeout(() => {
        // An unanswered range fetch is a silent carrier — re-dial before the resync.
        b.kickWsZombie?.("gap-timeout");
        finish(null);
      }, GAP_FETCH_TIMEOUT_MS);
      gapTimerRef.current = timer;
      b.emit("aiSince", { sessionId, after, epoch }, finish);
    };
    gapRunnerRef.current = runGapFetch;

    // Silence probe: a turn quiet for 10s may have lost its tail — the carrier drops
    // events nobody re-sends. Ask the host where it is; behind twice in a row (an
    // in-flight event can mimic a gap once) patches the hole or resyncs whole.
    let confirmTimer = null;
    let probeDeadline = null;
    const probeSilence = () => {
      if (probeBusyRef.current || hydratingRef.current || laneRef.current?.busy()) return;
      if (!isVisibleRef.current || !useConnectionStore.getState().connected) return;
      probeBusyRef.current = true;
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probeBusyRef.current = false;
        const behind = Boolean(res?.ok) && (
          (res.epoch != null && logEpochRef.current != null && res.epoch !== logEpochRef.current)
          || (typeof res.seq === "number" && res.seq > appliedSeqRef.current)
        );
        // A probe nobody answered may have gone into a zombie WS — re-dial the carrier.
        if (!res?.ok) busRef.current?.kickWsZombie?.("silence-probe");
        // The host says the turn is over while the pane still shows it running — a lost
        // turn_complete is exactly that. Close it, and pull the log if the answer row is
        // empty: the pane missed the whole stream, not just its tail.
        if (res?.ok && res.isTurnRunning === false && typeof res.seq === "number"
          && res.seq === appliedSeqRef.current
          && useAiStore.getState().bySession[sessionId]?.isTurnRunning) {
          termLog("ai-hydrate", "silence probe: turn ended unseen", { sessionId, seq: res.seq });
          useAiStore.getState().setTurnRunning(sessionId, false);
          if (emptyAnswerRow(useAiStore.getState().bySession[sessionId]?.messages)) {
            laneRef.current?.request("hydrate");
          }
          peekMissRef.current = 0;
          return;
        }
        if (!behind) {
          peekMissRef.current = 0;
          silenceNeedRef.current = Math.min(silenceNeedRef.current * 2, SILENCE_PEEK_MAX_MS);
          return;
        }
        peekMissRef.current++;
        if (peekMissRef.current === 1) { confirmTimer = setTimeout(probeSilence, GAP_CONFIRM_MS); return; }
        peekMissRef.current = 0;
        if (res.epoch != null && res.epoch === logEpochRef.current) laneRef.current?.request("gap");
        else laneRef.current?.request("hydrate");
      };
      const timer = setTimeout(() => finish(null), PEEK_TIMEOUT_MS);
      probeDeadline = timer;
      busRef.current?.emit("ai:peekSeq", { sessionId, haveSeq: appliedSeqRef.current, epoch: logEpochRef.current }, finish);
    };
    const silenceTimer = setInterval(() => {
      const st = useAiStore.getState().bySession[sessionId];
      // Cover the sent-but-unechoed prompt too: its user_message lost leaves no running flag to watch.
      const promptPending = Date.now() - promptSentAtRef.current < 15_000;
      if (!st?.isTurnRunning && !promptPending) { peekMissRef.current = 0; return; }
      if (!lastEventAtRef.current || Date.now() - lastEventAtRef.current < silenceNeedRef.current) return;
      probeSilence();
    }, 5000);

    bus.on("ai:event", handleAiEvent);
    return () => {
      bus.off("ai:event", handleAiEvent);
      clearInterval(silenceTimer);
      if (confirmTimer) clearTimeout(confirmTimer);
      if (probeDeadline) clearTimeout(probeDeadline);
      gapRunnerRef.current = null;
      if (gapTimerRef.current) clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
      // The session is going away — persist whatever tail this pane last had.
      if (cacheWriteTimerRef.current) clearTimeout(cacheWriteTimerRef.current);
      cacheWriteTimerRef.current = null;
      writeCacheNow();
      // A pane closing mid-frame must not swallow the last tokens it received.
      flushStreamed();
    };
  }, [bus, sessionId, applyEvent, noteTail, scheduleCacheWrite, writeCacheNow]);

  // 3. User actions
  const sendPrompt = useCallback(
    (text, { attachments = null, promptId = null, retries = 0 } = {}) => {
      if (!text && !attachments?.length) return;
      // Resend and auto-resend skip the composer, where history is written — record
      // here too so a swallowed send stays reusable (the store dedupes a repeat).
      rememberPrompt(text);
      // One id per typed prompt; a Resend reuses it so the host can drop a repeat.
      const id = promptId || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Arm the silence probe's prompt window: a lost user_message echo leaves no
      // running flag for it to key on.
      promptSentAtRef.current = Date.now();
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
      // #48: a dead-but-not-closed carrier swallows the emit silently — the ack wraps
      // it so the loss surfaces as a resendable error instead of vanishing.
      const onLost = (reason) => {
        useAiStore.getState().clearPromptSending(sessionId, text);
        // The host already echoed it: the ack was slow, the prompt is not lost.
        if (promptAlreadyShown(sessionId, text)) { removePending(sessionId, id); return; }
        useAiStore.getState().setPromptError(sessionId, text, reason, attachments, id, retries);
        // Timeout = ready-but-silent carrier; re-dial the zombie WS so replay/Resend has a lane.
        if (reason === "timeout" && b?.hostCaps?.promptDedupe) b.kickWsZombie?.("prompt-lost");
      };
      // An ack proves the host accepted it; the turn is alive when the echo arrives.
      // Silence past the budget, with nothing shown/running/queued, is a prompt that
      // died between ack and turn — offer it back instead of leaving the chat blank.
      const armEchoWatch = () => {
        if (!text) return;
        const watch = createEchoWatchdog({
          timeoutMs: PROMPT_ECHO_TIMEOUT_MS,
          onMissing: () => {
            echoWatchRef.current.delete(id);
            if (promptAlreadyShown(sessionId, text)) return;
            const st = useAiStore.getState().bySession[sessionId];
            if (st?.isTurnRunning) return;
            if (st?.queue?.some((q) => q.text === text)) return;
            useAiStore.getState().clearPromptSending(sessionId, text);
            useAiStore.getState().setPromptError(sessionId, text, "timeout", attachments, id, retries);
          }
        });
        // A Resend reuses the id: the old watch must not fire against the new attempt.
        const prev = echoWatchRef.current.get(id);
        if (prev) { prev.watch.settle(); echoWatchRef.current.delete(id); }
        echoWatchRef.current.set(id, { text, watch });
        watch.arm();
      };
      // Survives a reload until the host confirms it.
      if (text) addPending(sessionId, { id, text, page: PAGE_ID });
      // No bus yet (host still connecting): say so instead of dropping the prompt.
      if (!b) { onLost("offline"); return; }
      if (text) useAiStore.getState().setPromptSending(sessionId, text);
      emitPromptAck(
        (payload, done) => b.emit("ai:prompt", payload, (res) => {
          if (res?.ok) {
            removePending(sessionId, id);
            useAiStore.getState().clearPromptSending(sessionId, text);
            armEchoWatch();
          }
          done(res);
        }),
        {
          sessionId,
          message: text,
          cwd: workspacePath,
          promptId: id,
          ...(attachments?.length ? { attachments } : {})
        },
        PROMPT_ACK_TIMEOUT_MS,
        onLost,
        setTimeout, clearTimeout,
        // The stream re-sent it after all — the host has it; resend would duplicate the turn.
        () => clearEchoedPromptError(sessionId, text)
      );
    },
    [sessionId, workspacePath]
  );

  // A reconnect is the one moment a "lost" prompt is known to be retryable for free:
  // the carrier is fresh, and the host's promptId dedupe makes a duplicate harmless.
  const autoResendLost = useCallback(() => {
    const lost = useAiStore.getState().bySession[sessionId]?.promptError;
    if (!lost?.text) return;
    // The store already shows it: the ack was slow, not lost — resending would run it twice.
    if (promptAlreadyShown(sessionId, lost.text)) {
      termLog("ai-prompt", "auto-resend skipped (already shown)", { text: String(lost.text).slice(0, 24) });
      useAiStore.getState().clearPromptError(sessionId);
      return;
    }
    // Without its own id the host cannot drop a repeat, and the resend becomes a new turn.
    if (!lost.promptId) return;
    // An older host cannot drop a repeated promptId — a silent resend could run the turn twice.
    if (!busRef.current?.hostCaps?.promptDedupe) return;
    const retries = (lost.retries || 0) + 1;
    if (retries > PROMPT_AUTO_RETRY_MAX) return;
    useAiStore.getState().clearPromptError(sessionId);
    sendPrompt(lost.text, { attachments: lost.attachments || null, promptId: lost.promptId, retries });
  }, [sessionId, sendPrompt]);
  useEffect(() => {
    autoResendRef.current = autoResendLost;
  }, [autoResendLost]);

  const removeQueueItem = useCallback(
    (id) => {
      const b = busRef.current; // no bus → the host still holds it; removing locally would lie
      if (!b) return;
      const curr = useAiStore.getState().bySession[sessionId]?.queue || [];
      const idx = curr.findIndex((item) => item.id === id);
      if (idx === -1) return;
      const item = curr[idx];
      useAiStore.getState().setQueue(sessionId, curr.filter((x) => x.id !== id));
      // A remove that never landed would let a deleted prompt RUN when the turn ends —
      // put it back until the host's own queue_update says otherwise.
      emitPromptAck(
        (payload, done) => b.emit("ai:queueRemove", payload, done),
        { sessionId, id },
        RESOLVE_ACK_TIMEOUT_MS,
        () => {
          const q = [...(useAiStore.getState().bySession[sessionId]?.queue || [])];
          q.splice(Math.min(idx, q.length), 0, item);
          useAiStore.getState().setQueue(sessionId, q);
        }
      );
    },
    [sessionId]
  );

  const clearQueue = useCallback(
    () => {
      const b = busRef.current;
      const curr = useAiStore.getState().bySession[sessionId]?.queue || [];
      if (!b || !curr.length) return;
      useAiStore.getState().setQueue(sessionId, []);
      emitPromptAck(
        (payload, done) => b.emit("ai:queueClear", payload, done),
        { sessionId },
        RESOLVE_ACK_TIMEOUT_MS,
        () => useAiStore.getState().setQueue(sessionId, curr) // same law as remove: undone until the host agrees
      );
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
      const { messages: older, before, hasMore, answered } = result;
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
