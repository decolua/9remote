"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { updateToolTree, settleRunningTools } from "@/features/ai/lib/toolTree";
import { applyTaskRecord, foldTaskRecords, TASK_ENDED, lastIndexOfCompacting } from "@/features/ai/lib/harnessTasks";
import { upsertTask } from "@/features/ai/lib/taskList";

// persist writes on EVERY set and a streamed turn sets per frame — compare the payload first.
const jsonStorage = createJSONStorage(() => window.localStorage);
let lastWritten = null;
// Undefined without a DOM (server render) — persist then skips writing, as by default.
const aiStorage = jsonStorage && {
  ...jsonStorage,
  setItem: (name, raw) => {
    if (raw === lastWritten) return;
    lastWritten = raw;
    jsonStorage.setItem(name, raw);
  }
};

// Date.now() alone collided (prompt + placeholder shared one key) — the counter keeps ids unique.
let msgSeq = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${++msgSeq}`;

const INITIAL_SESSION_STATE = {
  messages: [],
  isTurnRunning: false,
  // Host clock at turn start; the live line measures against the same clock, no skew.
  turnStartedAt: 0,
  // Host-measured span of the LAST turn — a late-loading pane saw neither edge of it.
  lastTurnMs: 0,
  activePermission: null,
  // The last answer to this gate never reached the host — the card stays up and says so.
  gateError: false,
  // A blocked action the CLI reported; nothing to resolve — it offers a mode escalation.
  activeBlocked: null,
  // null = untold yet; a hardcoded "default" would show the wrong mode on codex/opencode.
  permissionMode: null,
  stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
  // stats snapshot at turn start; the turn's own usage is the difference.
  turnBaseline: { inputTokens: 0, outputTokens: 0 },
  metadata: { model: "", skills: [], mcpServers: [] },
  tasks: [], // TaskCreate/TaskUpdate checklist
  // Harness task state straight off the CLI's records — lib/harnessTasks.js owns the shape.
  harnessTasks: [],
  queue: [], // Prompts queued while a turn is running
};

// Persisted slices keep prefs only — always read through the defaults.
const sessionOf = (state, sessionId) => ({ ...INITIAL_SESSION_STATE, ...state.bySession[sessionId] });

// Settle tool rows of ended tasks from the whole list — a restart hydrates rows already dead; idempotent.
function settleTasks(tasks, messages) {
  if (!messages?.length) return null;
  const ended = tasks.filter((t) => t.toolUseId && TASK_ENDED.has(t.status));
  if (!ended.length) return null;
  let next = messages;
  for (const task of ended) {
    const status = task.status === "failed" ? "error" : "done";
    const settled = next.map((m) => {
      if (!m.tools) return m;
      const tools = updateToolTree(
        m.tools,
        (t) => t.id === task.toolUseId && t.status === "running",
        (t) => ({ ...t, status })
      );
      return tools ? { ...m, tools } : m;
    });
    if (settled.some((m, i) => m !== next[i])) next = settled;
  }
  return next === messages ? null : next;
}

export const useAiStore = create(
  persist(
    (set, get) => ({
      bySession: {},

      initSession: (sessionId) => {
        if (!sessionId || get().bySession[sessionId]) return;
        set((state) => ({
          bySession: {
            ...state.bySession,
            [sessionId]: { ...INITIAL_SESSION_STATE }
          }
        }));
      },

      // One reader folds the harness records, so the live and replay paths land the same list.
      // setTaskRecords REPLACES it with what the host states for a reset — the 32KB window cannot carry tasks.
      setTaskRecords: (sessionId, records) => {
        // An EMPTY array is meaningful (a /clear); only an absent field (older host) is ignored.
        if (!sessionId || !Array.isArray(records)) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const next = foldTaskRecords(records, []);
          const messages = settleTasks(next, curr.messages);
          if (next === curr.harnessTasks && !messages) return state;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, harnessTasks: next, ...(messages ? { messages } : null) }
            }
          };
        });
      },

      applyTaskRecords: (sessionId, records) => {
        if (!sessionId || !records?.length) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const before = curr.harnessTasks || [];
          let next = before;
          for (const [type, subtype, record, ageMs] of records) next = applyTaskRecord(next, type, subtype, record, ageMs);
          // An ended task settles its row — a background shell's only result is the launch ack, or it spins forever.
          const messages = settleTasks(next, curr.messages);
          if (next === before && !messages) return state;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, harnessTasks: next, ...(messages ? { messages } : null) }
            }
          };
        });
      },

      // A harness line for the timeline, appended as its own row — the CLI speaking, not the agent answering.
      addNotice: (sessionId, notice) => {
        const content = typeof notice?.content === "string" ? notice.content.trim() : "";
        if (!sessionId) return;
        // A settled compaction must still CLOSE its row even with no text; other empty notices are bookkeeping.
        if (!content && !notice?.compactSettled) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          // The CLI re-announces a running compaction on a ~30s heartbeat (a precomputed compact
          // awaiting the turn) — same compaction, so the row and its clock stay as they are.
          if (notice?.compacting && lastIndexOfCompacting(curr.messages) !== -1) return state;
          // Scan back, not the last row — another record can sit between a compaction's start and end.
          const runningAt = notice?.compactSettled ? lastIndexOfCompacting(curr.messages) : -1;
          // A settled compaction REPLACES the "Compacting…" row(s) it ends.
          if (runningAt !== -1) {
            // All of them, not just the last: a pre-fix store can hold one row per heartbeat.
            const first = curr.messages.findIndex((m) => m?.compacting);
            const messages = curr.messages.filter((m) => !m?.compacting);
            if (content) {
              messages.splice(first, 0, {
                id: nextId("n"), role: "notice", subtype: notice.subtype || "", level: notice.level || "info", content,
                ...(notice.compact ? { compact: notice.compact } : null)
              });
            }
            return { bySession: { ...state.bySession, [sessionId]: { ...curr, messages } } };
          }
          // A bare `return` hands zustand undefined, which wipes the whole store.
          if (!content) return state;
          const row = {
            id: nextId("n"),
            role: "notice",
            subtype: notice.subtype || "",
            level: notice.level || "info",
            content,
            // Only set when the reader produced one — see noticeFrom.
            ...(notice.file ? { file: notice.file } : null),
            // The compaction's own numbers ("557k → 21k tokens") — see harnessTasks.compactFrom.
            ...(notice.compact ? { compact: notice.compact } : null),
            // A compaction still running, which the boundary record later settles.
            ...(notice.compacting ? { compacting: true } : null)
          };
          // Drop the empty placeholder the prompt opened — the answer has not started (same rule as the replay door).
          const last = curr.messages[curr.messages.length - 1];
          const messages = last && last.role === "assistant" && !last.content && !last.thinking && !(last.tools || []).length
            ? [...curr.messages.slice(0, -1), row]
            : [...curr.messages, row];
          return { bySession: { ...state.bySession, [sessionId]: { ...curr, messages } } };
        });
      },

      setPermissionMode: (sessionId, mode) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, permissionMode: mode }
            }
          };
        });
      },

      setTurnRunning: (sessionId, isTurnRunning) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, isTurnRunning }
            }
          };
        });
      },

      setQueue: (sessionId, queue) => {
        if (!sessionId) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const next = Array.isArray(queue) ? queue : [];
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, queue: next }
            }
          };
        });
      },

      setMetadata: (sessionId, metadata) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, metadata: { ...curr.metadata, ...metadata } }
            }
          };
        });
      },

      setStats: (sessionId, stats) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, stats: { ...curr.stats, ...stats } }
            }
          };
        });
      },

      // A replayed prompt already happened — starting a turn here would re-measure the span as ~0ms.
      addUserMessage: (sessionId, text, attachments = null, replay = false) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const userMsg = { id: nextId("u"), role: "user", content: text, attachments: attachments || [] };
          const assistantPlaceholder = {
            id: nextId("a"),
            role: "assistant",
            content: "",
            thinking: "",
            diffs: [],
            tools: [],
            isLive: true
          };
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                ...(replay ? null : {
                  isTurnRunning: true,
                  turnStartedAt: Date.now(),
                  // The turn this line will summarize has not ended yet.
                  lastTurnMs: 0,
                  // The on-screen counter is this turn's usage — remember where the session total stood.
                  turnBaseline: {
                    inputTokens: curr.stats.inputTokens || 0,
                    outputTokens: curr.stats.outputTokens || 0
                  },
                  activeBlocked: null
                }),
                messages: [...curr.messages, userMsg, assistantPlaceholder]
              }
            }
          };
        });
      },

      appendDelta: (sessionId, text) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          const last = list[list.length - 1];
          if (!last || last.role !== "assistant" || !last.isLive) {
            list.push({ id: nextId("msg"), role: "assistant", content: text || "", isLive: true, diffs: [], tools: [] });
          } else {
            // New object identity — memoized bubbles must see the change to re-render.
            list[list.length - 1] = { ...last, content: (last.content || "") + (text || "") };
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      appendThinking: (sessionId, text) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          const last = list[list.length - 1];
          if (!last || last.role !== "assistant" || !last.isLive) {
            list.push({ id: nextId("msg"), role: "assistant", content: "", thinking: text || "", isLive: true, diffs: [], tools: [] });
          } else {
            list[list.length - 1] = { ...last, thinking: (last.thinking || "") + (text || "") };
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      // Text + thinking as ONE set per frame — two writes doubled the nested-update pressure that crashed panes.
      appendStream: (sessionId, text, thinking) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          let last = list[list.length - 1];
          if (!last || last.role !== "assistant" || !last.isLive) {
            list.push({ id: nextId("msg"), role: "assistant", content: text || "", thinking: thinking || "", isLive: true, diffs: [], tools: [] });
          } else {
            list[list.length - 1] = {
              ...last,
              ...(text ? { content: (last.content || "") + text } : null),
              ...(thinking ? { thinking: (last.thinking || "") + thinking } : null)
            };
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      appendDiff: (sessionId, diffData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          let last = list[list.length - 1];
          if (!last || last.role !== "assistant") {
            last = { id: nextId("msg"), role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
            list.push(last);
          } else {
            last = { ...last };
            list[list.length - 1] = last;
          }
          const diffs = [...(last.diffs || [])];
          const existingIdx = diffs.findIndex((d) => d.file === diffData.file);
          if (existingIdx !== -1) {
            diffs[existingIdx] = diffData;
          } else {
            diffs.push(diffData);
          }
          last.diffs = diffs;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      appendTool: (sessionId, toolData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          const last = list[list.length - 1];
          // Text already streamed in this segment → close it and open a new one so tools interleave in arrival order.
          if (last && last.role === "assistant" && last.isLive && ((last.content || last.thinking || "").length > 0)) {
            list[list.length - 1] = { ...last, isLive: false };
            list.push({
              id: nextId("msg"),
              role: "assistant",
              content: "",
              isLive: true,
              diffs: [],
              tools: [{ ...toolData, status: toolData.status || "running" }]
            });
          } else if (!last || last.role !== "assistant") {
            list.push({
              id: nextId("msg"),
              role: "assistant",
              content: "",
              isLive: true,
              diffs: [],
              tools: [{ ...toolData, status: toolData.status || "running" }]
            });
          } else {
            const tools = [...(last.tools || [])];
            const existingIdx = tools.findIndex((t) => t.id === toolData.id);
            if (existingIdx !== -1) {
              tools[existingIdx] = { ...tools[existingIdx], ...toolData };
            } else {
              tools.push({ ...toolData, status: toolData.status || "running" });
            }
            list[list.length - 1] = { ...last, tools };
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      updateToolResult: (sessionId, resultData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          // The tool may live in an EARLIER segment — scan from the end
          for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            if (!msg?.tools) continue;
            const existingIdx = msg.tools.findIndex((t) => t.id === resultData.id);
            if (existingIdx !== -1) {
              const tools = [...msg.tools];
              tools[existingIdx] = { ...tools[existingIdx], ...resultData, status: resultData.status || "done" };
              list[i] = { ...msg, tools };
              break;
            }
            // A result for an unknown id (after reload) is dropped, not duplicated.
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      // A sub-agent's call nests under the parentToolUseId card; dropped when the parent is unknown.
      nestTool: (sessionId, toolData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            const tools = updateToolTree(msg?.tools, (t) => t.id === toolData.parentToolUseId, (parent) => {
              const children = [...(parent.children || [])];
              const idx = children.findIndex((c) => c.id === toolData.id);
              if (idx !== -1) children[idx] = { ...children[idx], ...toolData };
              else children.push({ ...toolData, status: toolData.status || "running" });
              return { ...parent, children };
            });
            if (!tools) continue;
            list[i] = { ...msg, tools };
            break;
          }
          return { bySession: { ...state.bySession, [sessionId]: { ...curr, messages: list } } };
        });
      },

      nestToolResult: (sessionId, resultData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const list = [...curr.messages];
          for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            const tools = updateToolTree(
              msg?.tools,
              (t) => (t.children || []).some((c) => c.id === resultData.id),
              (parent) => ({
                ...parent,
                children: parent.children.map((c) =>
                  c.id === resultData.id ? { ...c, ...resultData, status: resultData.status || "done" } : c
                )
              })
            );
            if (!tools) continue;
            list[i] = { ...msg, tools };
            break;
          }
          return { bySession: { ...state.bySession, [sessionId]: { ...curr, messages: list } } };
        });
      },

      setPermission: (sessionId, permission) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activePermission: permission, gateError: false }
            }
          };
        });
      },

      clearPermission: (sessionId) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activePermission: null }
            }
          };
        });
      },

      // A blocked action: show a card until the turn ends or the user escalates.
      setBlocked: (sessionId, blocked) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activeBlocked: blocked }
            }
          };
        });
      },

      clearBlocked: (sessionId) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activeBlocked: null }
            }
          };
        });
      },

      // The gate's answer never reached the CLI — kept so the card can say so and offer a retry.
      setGateError: (sessionId, requestId, error = true) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          if (curr.activePermission?.requestId !== requestId) return state;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, gateError: error }
            }
          };
        });
      },

      // turnMs is the host's own span; a replayed ending closes its rows but must not re-measure the turn ("Worked for 0s").
      finishTurn: (sessionId, stats, turnMs = 0, replay = false) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          // Sweep every message — a tool whose result never arrived must not spin past the turn.
          const messages = curr.messages.map((m, idx) => ({
            ...m,
            ...(idx === curr.messages.length - 1 ? { isLive: false } : null),
            ...(m.tools ? { tools: settleRunningTools(m.tools) } : null),
          }));
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                ...(replay ? { activePermission: null } : {
                  isTurnRunning: false,
                  // turnStartedAt kept: the summary line needs the mark; a new turn overwrites it.
                  lastTurnMs: turnMs || (curr.turnStartedAt ? Date.now() - curr.turnStartedAt : curr.lastTurnMs),
                  activePermission: null,
                  stats: stats ? { ...curr.stats, ...stats } : curr.stats
                }),
                messages
              }
            }
          };
        });
      },

      // The log owns messages/tasks/span but NOT the running flag — a mid-turn reload must not read as finished.
      clearMessages: (sessionId) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages: [],
                tasks: [],
                turnStartedAt: 0,
                lastTurnMs: 0,
                activePermission: null,
                activeBlocked: null,
                stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
                turnBaseline: { inputTokens: 0, outputTokens: 0 }
              }
            }
          };
        });
      },

      // Optimistic rewind: keep through the prompt with the edited text until the host echoes it back.
      rewindToMessage: (sessionId, messageId, newText) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const idx = curr.messages.findIndex((m) => m.id === messageId);
          if (idx === -1) return state;
          const messages = curr.messages.slice(0, idx + 1);
          if (newText) messages[idx] = { ...messages[idx], content: newText };
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages,
                isTurnRunning: false,
                turnStartedAt: 0,
                lastTurnMs: 0,
                activePermission: null
              }
            }
          };
        });
      },

      // Rules live in lib/taskList.js so the replay path lands the same list.
      upsertTask: (sessionId, taskData) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const tasks = upsertTask(curr.tasks, taskData);
          if (tasks === curr.tasks) return state;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, tasks }
            }
          };
        });
      },

      // Batch hydration: one state update instead of 5000+ actions on join/reconnect.
      // A gate the replay does not carry is one nobody waits on — the caller sets it back when it does.
      hydrateSession: (sessionId, { messages = [], tasks = [], isTurnRunning = false, metadata = {}, stats = null, permissionMode = null, activeBlocked = null, elapsedMs = 0, lastTurnMs = 0, harnessTasks = null, queue = null }) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          // A replayed `running` row may have ended since; the harness tasks say which.
          const settled = harnessTasks ? settleTasks(harnessTasks, messages) : null;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                activePermission: null,
                messages: settled || messages,
                tasks,
                isTurnRunning,
                ...(Array.isArray(queue) ? { queue } : {}),
                // Anchor to the host's duration so a mid-turn rejoin shows the whole turn.
                turnStartedAt: isTurnRunning ? Date.now() - (elapsedMs || 0) : 0,
                // 0 while running — the pane freezes its own span on the falling edge (see AiTurnStatus).
                lastTurnMs: isTurnRunning ? 0 : (lastTurnMs || 0),
                // No baseline from the replay — a mid-turn rejoin shows the session total.
                turnBaseline: isTurnRunning
                  ? { inputTokens: 0, outputTokens: 0 }
                  : { inputTokens: stats?.inputTokens || 0, outputTokens: stats?.outputTokens || 0 },
                metadata: { ...curr.metadata, ...metadata },
                stats: stats ? { ...curr.stats, ...stats } : curr.stats,
                // A blocked card with no matching replay event is stale.
                activeBlocked,
                ...(permissionMode ? { permissionMode } : {}),
                // Only when the caller sent one — an older agent's ack carries none.
                ...(harnessTasks ? { harnessTasks } : {})
              }
            }
          };
        });
      },

      // Scroll-up fetch: older turns in front of the window; tasks are state, not timeline.
      prependMessages: (sessionId, older) => {
        if (!older?.length) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          // The store's whole task list judges which replayed `running` rows have ended.
          const messages = settleTasks(curr.harnessTasks || [], older) || older;
          // An id that still collides (two panes, a rewind) gets a fresh store id — no key twice.
          const have = new Set(curr.messages.map((m) => m.id));
          const safe = messages.map((m) => {
            if (!have.has(m.id)) { have.add(m.id); return m; }
            return { ...m, id: nextId(m.id.split("-")[0]) };
          });
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: [...safe, ...curr.messages] }
            }
          };
        });
      },

      /**
       * Put back what the log carries, right after a reset cleared it.
       *
       * A reset says "this is a new log", and the host broadcasts one with every hydrate —
       * including the one answering an F5, whose ack stated the same two values a moment
       * earlier. They must agree: the span alone, restored while the reset had just said
       * `isTurnRunning = false`, printed "Worked for …" over a turn still streaming.
       * A reset from a host that states nothing (a /clear, an older agent) leaves the
       * cleared values alone.
       */
      restoreTurnState: (sessionId, data = {}) => {
        // A reset that states no turn state says nothing about the turn — it is a /clear, an
        // older agent, or any host that only knows where the window starts. Restoring the
        // span it happens to carry would paint "Worked for …" over a turn that is streaming,
        // which is worse than showing no summary at all: the ack already put the real state
        // in place.
        if (data.isTurnRunning === undefined) return;
        const { isTurnRunning, lastTurnMs = 0, elapsedMs = 0 } = data;
        if (!isTurnRunning && !lastTurnMs) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                isTurnRunning,
                lastTurnMs,
                // Anchor the mark so the live line reads `elapsedMs` — a duration the host
                // measured — instead of restarting at zero. Only a RUNNING turn gets one:
                // for a finished turn the replayed turn_complete would follow within the
                // same batch, measure ~0ms from a fresh mark, and overwrite the real span.
                turnStartedAt: isTurnRunning ? Date.now() - (elapsedMs || 0) : 0
              }
            }
          };
        });
      },

      removeSession: (sessionId) => {
        set((state) => {
          const { [sessionId]: _, ...rest } = state.bySession;
          return { bySession: rest };
        });
      }
    }),
    {
      name: "9remote-ai-store",
      storage: aiStorage,
      // Only persist user preferences per session. Messages and tasks are authoritative
      // on the host daemon and re-hydrated on connect — persisting thousands of messages
      // to synchronous localStorage triggers severe main-thread freezing and V8 OOM crashes.
      partialize: (state) => ({
        bySession: Object.fromEntries(
          Object.entries(state?.bySession || {}).map(([sid, sess]) => [
            sid,
            {
              // null is "not chosen yet" — persisting a concrete "default" here would
              // outlive the reload and pin every engine to the wrong mode.
              permissionMode: sess?.permissionMode ?? null,
              metadata: {
                model: sess?.metadata?.model || "",
                effort: sess?.metadata?.effort || ""
              }
            }
          ])
        )
      })
    }
  )
);
