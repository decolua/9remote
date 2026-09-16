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
import { RECOVER_DEBOUNCE_MS } from "@/features/terminal/constants/terminalConfig";
import { RESOLVE_ACK_TIMEOUT_MS } from "../constants";

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
// Applying a rewind is not a fetch: claude's file half spawns its CLI twice, and the
// host allows each spawn a minute (see agent/features/ai/claudeRewind.js). On the fetch
// budget a working rewind was reported to the user as "the host did not answer", while
// the host went on to finish it — a failure message for a success.
const REWIND_APPLY_TIMEOUT_MS = 130000;
// A hydrate whose ack never arrived leaves the pane without the host's tail, and with
// it the load-older affordance. The ladder that re-asks lives in lib/hydrateRetry, and
// the lib owns the delays — this hook only drives its timer.

// Pure reducer that transforms an event log into a complete session snapshot in RAM
// in <3ms, avoiding thousands of re-renders and synchronous store dispatches.
export function reduceSessionEvents(events = [], engine = "claude", idBase = 0) {  const messages = [];
  let tasks = [];
  // The CLI's own records, in order, for whatever the pane learns to read next. The task
  // model is folded out of them at the end rather than inside the switch: the rules live
  // in lib/harnessTasks.js, so the live path and this replay call the same code.
  const harnessRecords = [];
  let metadata = { model: "", skills: [], mcpServers: [] };
  let stats = { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 };
  let isTurnRunning = false;
  let activePermission = null;
  let activeBlocked = null;
  let permissionMode = null;
  let turnEnded = false;
  let lastTurn = null;
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
        break;
      case "turn_complete":
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        if (data?.stats) stats = { ...stats, ...data.stats };
        if (messages.length > 0) messages[messages.length - 1].isLive = false;
        // Whether the turn FAILED travels with its end. Without this the pane can only
        // say a turn finished, never that it finished badly.
        lastTurn = { isError: Boolean(data?.isError), subtype: data?.subtype || "", result: data?.result || "" };
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
        // The watchdog killed a silent turn. Ends the turn like `stopped`, but draws no
        // bubble: it fires on a timeout guess, so a slow build must not read as an error.
        turnEnded = true;
        isTurnRunning = false;
        activePermission = null;
        for (const m of messages) if (m.isLive) m.isLive = false;
        break;
      case "exit":
        turnEnded = true;
        // The CLI process went away. Turn ends either way — without this the pane
        // kept spinning on a process that was already gone (only claudeAdapter emits it).
        // The gate dies with it: a card replayed against a dead process answers nobody.
        isTurnRunning = false;
        activePermission = null;
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
        harnessRecords.length = 0;
        isTurnRunning = false;
        activePermission = null;
        activeBlocked = null;
        lastTurn = null;
        break;
      // A record the pane has no card for. Kept rather than dropped: the pane is a
      // re-render of the TUI, and a record it cannot draw YET must not leave a hole
      // that is invisible from both ends.
      case "cli_event": {
        const type = data?.type || "";
        const record = data?.record || null;
        harnessRecords.push([type, data?.subtype || "", record]);
        // A record the harness gave something readable to is a line in the timeline, in
        // the order it happened. Which ones those are is the harness's call — see
        // noticeFrom.
        const notice = noticeFrom(type, record);
        if (!notice) break;
        // A settled compaction REPLACES the "Compacting…" row it ends — one happening, and
        // the CLI states its start and its end as two frames. With an error to show it takes
        // the row's place; a skipped one has nothing to say, so dropping the row IS the
        // update. Same rule as the live store door (see addNotice).
        // `compactSettled` is a wire between those two doors, not part of the row: the
        // reducer has already used it here, and nothing downstream reads it.
        const { compactSettled, ...row } = notice;
        // Found by scanning back, not by looking at the last row: the CLI can put another
        // readable record between the start and the end of a compaction (`api_error` does
        // exactly that when the summarization call fails), and a rule that only checked its
        // immediate neighbour then left the spinner running under the finished row.
        const runningAt = compactSettled ? lastIndexOfCompacting(messages) : -1;
        if (runningAt !== -1) {
          if (row.content?.trim()) messages[runningAt] = { id: `n-${++msgSeq}`, role: "notice", ...row };
          else messages.splice(runningAt, 1);
          break;
        }
        // Nothing left to draw — a settled compaction that had no row to close, and every
        // other reader already refuses empty text. Carrying it would put a blank row in the
        // timeline that the pane then declines to paint.
        if (!row.content?.trim()) break;
        // The placeholder `user_message` opened is for the answer, and the answer has not
        // started. Dropping it here is what stops the pane drawing a bare turn (a bubble
        // with nothing in it) ahead of a line that arrived first; the next `delta` opens
        // a fresh one.
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

  // Nothing is still running once the turn is over. Settled here rather than in each of
  // the ending events so every one of them is covered. Keyed on having SEEN the end,
  // not on isTurnRunning: a page of older events is reduced on its own and carries no
  // end event, and its tools must stay as they are.
  if (turnEnded) {
    for (const m of messages) if (m.tools) m.tools = settleRunningTools(m.tools);
  }

  let harnessTasks = [];
  for (const [type, subtype, record] of harnessRecords) harnessTasks = applyTaskRecord(harnessTasks, type, subtype, record);

  return {
    messages, tasks, metadata, stats, isTurnRunning, activePermission, activeBlocked, permissionMode,
    harnessRecords,
    harnessTasks,
    lastTurn
  };
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
  // A boolean selector, so this re-renders on carrier changes only — not on the
  // streamed frames the "don't read the session slice" note below is about.
  const connected = useConnectionStore((s) => s.connected);

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
  // The re-ask ladder ran out with nothing answered. Distinct from `synced`: the pane
  // must offer a retry instead of spinning on a hydrate that is no longer in flight.
  const [hydrateFailed, setHydrateFailed] = useState(false);
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
        // `replay` marks a log being re-sent (a hydrate rebuilt it, a rewind, a /resume):
        // the prompt already happened, so it opens no turn here — see aiStore.addUserMessage.
        addUserMessage(sid, data.text, data.attachments || null, Boolean(data?.replay));
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
      // A client that joined mid-turn measures from its own join, so the host's span —
      // which rides with the event that ends the turn — is the honest number.
      case "turn_complete":
        finishTurn(sid, data.stats, data.turnMs, Boolean(data?.replay));
        break;
      case "stats":
        // codex/opencode report token usage mid-turn; claude folds it into turn_complete
        if (data?.stats) useAiStore.getState().setStats(sid, data.stats);
        break;
      case "stopped":
      case "exit":
        // The CLI process went away or was interrupted. The reducer has always ended the
        // turn on `exit`, but the live path had no case for it — so a CLI the watchdog
        // killed mid-gate left the pane spinning on a process that was already gone.
        // The gate goes with it: no process is left to answer it.
        clearPermission(sid);
        // The span of the turn this event just ended, when the host measured one.
        useAiStore.getState().finishTurn(sid, null, data?.turnMs);
        break;
      case "stall":
        // Same release as `stopped`, deliberately without the text `error` appends.
        setTurnRunning(sid, false);
        finishTurn(sid, null, data?.turnMs);
        break;
      case "error":
        // Spawn/CLI failure never produces a turn_complete — surface it as text
        // and release the turn, or the pane spins on a process that is gone.
        appendDelta(sid, `\n\n**Error:** ${data?.message || "AI process failed"}`);
        finishTurn(sid, null, data?.turnMs);
        break;
      case "conversation_reset":
        // The reset arrives after the ack that hydrated this same log (the host broadcasts
        // it alongside the replay), so it restates that log's turn state with it — the span
        // of the turn it ends on, and, when that turn is still streaming, the fact that it
        // is. Restoring only the span would print "Worked for …" over a running turn.
        // TEMP DIAGNOSTIC — the reset's own view of the turn, and the order it landed in
        // relative to the ack. Remove with the rest of the ai-status logging.
        termLog("ai-status", "reset", {
          sessionId: sid, isTurnRunning: data?.isTurnRunning, elapsedMs: data?.elapsedMs,
          lastTurnMs: data?.lastTurnMs, fromSeq: data?.fromSeq
        });
        useAiStore.getState().clearMessages(sid);
        // The host's task set, restated with the log it belongs to — the replayed window
        // below carries only what fitted in its tail, so a task from the top of a long
        // turn would come back missing. Applied BEFORE the replay, so the window's own
        // records fold on top of it.
        useAiStore.getState().setTaskRecords(sid, data?.taskRecords);
        useAiStore.getState().restoreTurnState(sid, data);
        break;
      // Every CLI record the pane has no card for goes to the store as-is; the fold into
      // a task list happens there, through the same reader the replay uses.
      case "cli_event": {
        const type = data?.type || "";
        const record = data?.record || null;
        useAiStore.getState().applyTaskRecords(sid, [[type, data?.subtype || "", record]]);
        // Same rule as the replay: the harness decides which records a person reads.
        const notice = noticeFrom(type, record);
        if (notice) useAiStore.getState().addNotice(sid, notice);
        break;
      }
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
  // Bumped whenever the host replaces the log (conversation_reset: /clear, /resume, rewind).
  // A round in flight when that happens holds seqs of the conversation that just ended, and
  // a high seq from it must not be read as "newer" by the gate below.
  const logEpochRef = useRef(0);
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
    // Every rung spent means the next ask is a repeat of the last backoff, not progress
    // — that is what the pane reports. A null delay is only "offline" or "a timer is
    // already armed", neither of which is a failure. The re-ask itself keeps coming.
    setHydrateFailed(Boolean(ladderRef.current?.exhausted()));
    // TEMP DIAGNOSTIC — the ladder's own decision, which is what decides whether the
    // pane ever re-asks. Remove with the rest of the ai-hydrate logging.
    termLog("ai-hydrate", "ladder", {
      delay: delay ?? null, exhausted: ladderRef.current?.exhausted(),
      connected: useConnectionStore.getState().connected, armed: retryTimerRef.current != null
    });
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
    if (hydratingRef.current) {
      // TEMP DIAGNOSTIC — a round is already open. If this line repeats while the pane
      // says Syncing, the gate is stuck: nothing will ever clear it. Remove with the
      // rest of the ai-hydrate logging.
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
    // TEMP DIAGNOSTIC — one line per round: when it opened, who triggered it, and how
    // long its ack took (see the matching "ack" log below). Remove with the rest.
    const sentAt = Date.now();
    termLog("ai-hydrate", "emit ai:create", {
      gen, sessionId, engine, cwd: workspacePath,
      carrier: useConnectionStore.getState().carrier,
      connected: useConnectionStore.getState().connected
    });
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
      const isNewest = gen === hydrateSeqRef.current;
      // The gate rule lives in the lib, beside the ladder it belongs to — see there for
      // why a superseded ack may still apply, and for the two ways one may not.
      if (!shouldApplyHydrateAck({
        isNewest,
        snapshotSeq: res?.session?.seq,
        appliedSeq: appliedSeqRef.current,
        sameLog: epoch === logEpochRef.current
      })) return;
      const events = res?.session?.events;
      // TEMP DIAGNOSTIC — the ack, or the absence of one (this line never printed = the
      // callback was never called at all). `ok:false` carries the host's own error.
      // Remove with the rest of the ai-hydrate logging.
      termLog("ai-hydrate", "ack", {
        gen, stale: gen !== hydrateSeqRef.current, ms: Date.now() - sentAt,
        ok: res?.ok ?? null, error: res?.error ?? null,
        events: Array.isArray(events) ? events.length : null,
        hasMore: res?.session?.hasMore ?? null
      });
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
        // TEMP DIAGNOSTIC — what the host said about the turn on this ack, which is the
        // value everything downstream reads. Remove with the rest of the ai-status logging.
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
            metadata: { ...hydrated.metadata, ...(res.session.effort ? { effort: res.session.effort } : {}) },
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
            harnessTasks: foldTaskRecords(res.session.taskRecords, hydrated.harnessTasks)
          });
          // The host states the gate itself when the CLI is holding one, so a request
          // that scrolled off the replay tail still comes back — a card that cannot be
          // reopened would leave the CLI waiting on an answer no surface can give.
          const gate = res.session.activePermission || hydrated.activePermission;
          if (gate) useAiStore.getState().setPermission(sessionId, gate);
        } else {
          setTurnRunning(sessionId, Boolean(res.session.isTurnRunning));
          // An empty window is not an absent task set: a session whose log the host holds
          // but cannot replay (every event over a frame, say) still has its tasks stated
          // beside the log. Skipping this left the strip empty on a session that has one.
          useAiStore.getState().setTaskRecords(sessionId, res.session.taskRecords);
          if (res.session.permissionMode) {
            useAiStore.getState().setPermissionMode(sessionId, res.session.permissionMode);
          }
          // No log to replay, but the adapter still knows what it has spent — a fresh
          // pane on a running session reads the same numbers as the one it replaced.
          if (res.session.stats) useAiStore.getState().setStats(sessionId, res.session.stats);
        }
        // The snapshot is authoritative for this log. Assign rather than max: after a
        // /resume or /clear the host starts a NEW log whose seqs begin at 1, so a
        // higher watermark left over from the previous log would drop every replay.
        appliedSeqRef.current = snapshotSeq;
      } finally {
        // Always drains — a failed ack must not discard events that really arrived.
        clearTimeout(releaseTimer);
        if (gen === hydrateSeqRef.current) releaseHeld();
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
      if (!document.hidden) requestHydrate();
    };
    // Page Lifecycle `resume`: Chrome Android wakes a frozen tab without firing a
    // visibilitychange (the same gap pmWatchers covers on the transport side). bfcache
    // restores need nothing extra — those do fire visibilitychange.
    bus.on("connect", requestHydrate);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("resume", onVisible);
    return () => {
      bus.off("connect", requestHydrate);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onVisible);
    };
  }, [bus, sessionId, requestHydrate]);

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
    if (connected && !was) requestHydrate();
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
      // pane may do, or restarts the log the text belongs to. A delta that turns out to be
      // one we already replayed must still flush what came before it, or that text would
      // land after the events that followed it.
      const isStream = payload.event === "delta" || payload.event === "thinking";
      if (!isStream) flushStreamed();
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
        applyEvent(sessionId, payload.event, payload.data);
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
      const b = busRef.current || useConnectionStore.getState().bus;
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
    const b = busRef.current || useConnectionStore.getState().bus;
    b?.emit("ai:stop", { sessionId });
    setTurnRunning(sessionId, false);
  }, [sessionId, setTurnRunning]);

  // Stop ONE background task. Fire and forget like the host side: the CLI reports the
  // stop as a `task_notification`, which is what settles the row — an optimistic local
  // update would claim an end that may not have happened.
  const stopTask = useCallback(
    (taskId) => {
      if (!taskId) return;
      const b = busRef.current || useConnectionStore.getState().bus;
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
    const b = busRef.current || useConnectionStore.getState().bus;
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
      const b = busRef.current || useConnectionStore.getState().bus;
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
      // Re-submit the edited text as the first prompt of the rewound conversation.
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
