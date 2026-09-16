"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { updateToolTree, settleRunningTools } from "@/features/ai/lib/toolTree";
import { applyTaskRecord } from "@/features/ai/lib/harnessTasks";
import { upsertTask } from "@/features/ai/lib/taskList";

// Zustand's persist writes on EVERY set, and a streamed answer sets the store once per
// frame — so a turn spends thousands of synchronous JSON.stringify + localStorage
// round-trips re-storing two fields (model, permissionMode) that did not change. Compare
// the serialized payload first: what this store persists only moves when the user picks
// a model or a mode.
const jsonStorage = createJSONStorage(() => window.localStorage);
let lastWritten = null;
// Undefined without a DOM (a server render) — persist then skips writing, as it would
// have by default.
const aiStorage = jsonStorage && {
  ...jsonStorage,
  setItem: (name, raw) => {
    if (raw === lastWritten) return;
    lastWritten = raw;
    jsonStorage.setItem(name, raw);
  }
};

// Message ids are minted here, and a user prompt plus its assistant placeholder used to
// take the same `Date.now()` — two rows, one key, which React reports as a duplicate
// child and may then drop. A monotonic counter makes every id unique within a ms.
let msgSeq = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${++msgSeq}`;

const INITIAL_SESSION_STATE = {
  messages: [],
  isTurnRunning: false,
  // Host clock at the moment the current turn started. Client-side only: the live line
  // measures against this same clock, so no skew is involved.
  turnStartedAt: 0,
  // How long the LAST turn took, measured by the host. A pane that loads after the turn
  // ended prints its span from here — its own clock saw neither edge (see AiTurnStatus).
  lastTurnMs: 0,
  activePermission: null,
  // The last answer to this gate never reached the host — the card stays up and says so.
  gateError: false,
  // A blocked action (sandbox/permission refusal) the CLI reported. Unlike
  // activePermission this has nothing to resolve — it offers a mode escalation.
  activeBlocked: null,
  // null = the host has not told us yet. The engine's own defaultMode is the fallback
  // at render time; a hardcoded "default" here would show the wrong mode on every
  // engine whose default is not "default" (codex, opencode).
  permissionMode: null,
  stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
  // `stats` is the host's session-running total; this is what it read when the current
  // turn started. The turn's own usage is the difference between the two.
  turnBaseline: { inputTokens: 0, outputTokens: 0 },
  metadata: { model: "", skills: [], mcpServers: [] },
  tasks: [], // TaskCreate/TaskUpdate checklist
  // The harness's own task state (a background shell, a sub-agent), read straight off the
  // CLI's records — see lib/harnessTasks.js, the only place that knows their shape.
  harnessTasks: [],
};

// Persisted slices keep prefs only, so a session restored from localStorage can be
// missing every other field. Actions always read through the defaults.
const sessionOf = (state, sessionId) => ({ ...INITIAL_SESSION_STATE, ...state.bySession[sessionId] });

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

      // The harness's task records, folded by the one reader that knows their shape.
      // Kept as a single action rather than four cases in the reducer's switch: the live
      // path and the replay path must land the same list, and two copies of the rules is
      // how they drift.
      applyTaskRecords: (sessionId, records) => {
        if (!sessionId || !records?.length) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          let next = curr.harnessTasks || [];
          for (const [type, subtype, record] of records) next = applyTaskRecord(next, type, subtype, record);
          if (next === curr.harnessTasks) return state;
          return { bySession: { ...state.bySession, [sessionId]: { ...curr, harnessTasks: next } } };
        });
      },

      /**
       * A line the harness asked the timeline to draw (see lib/harnessTasks.noticeFrom).
       *
       * Appended, never merged into an assistant row: it is the CLI speaking, not the
       * agent answering, and it has to keep its place between them. Empty text is refused
       * here as well as at the reader — a record with nothing to show is bookkeeping, not
       * a row the pane should carry.
       */
      addNotice: (sessionId, notice) => {
        const content = typeof notice?.content === "string" ? notice.content.trim() : "";
        if (!sessionId || !content) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          const row = {
            id: nextId("n"),
            role: "notice",
            subtype: notice.subtype || "",
            level: notice.level || "info",
            content,
            // A row that names a FILE carries it, so the pane can open it. Only set when
            // the reader produced one — see noticeFrom.
            ...(notice.file ? { file: notice.file } : null)
          };
          // The placeholder `addUserMessage` opened is for the answer, and the answer has
          // not started. Dropping it is what stops the pane drawing a bare turn ahead of
          // a line that arrived first; the next streamed token opens a fresh one.
          // Same rule as the replay door — see reduceSessionEvents.
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

      /**
       * A prompt, echoed by the host so every surface shows the same bubble.
       *
       * `replay: true` means the log is being re-sent (a hydrate rebuilt it, a rewind, a
       * /resume) and this prompt already happened. Such an event must NOT start a turn
       * here: it would move the mark the live line counts from, and the `turn_complete`
       * that follows it in the same batch would then measure ~0ms and overwrite the span
       * the host had just stated — the "Worked for 0s" on a chat that ran for minutes.
       */
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
                  // The counter on screen is this turn's own usage, so it starts at zero
                  // every prompt: remember where the session total stood.
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
            // New object identity — memoized bubbles must see the change to re-render
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
          // Text/thinking already streamed in this segment → close it and open a new
          // segment so tools interleave with text in arrival order (CLI timeline feel)
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
            // Not in this message and it has tools — keep looking; a result for an
            // unknown tool id (e.g. after reload) is dropped, not duplicated
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: list }
            }
          };
        });
      },

      // A sub-agent's tool call: it belongs to the Agent/Task card named by
      // parentToolUseId, not to a row of its own — the card counts them and lists
      // them nested. Dropped when the parent is unknown (a reload that lost it).
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

      // A gate the CLI is holding but whose answer never reached it. Kept beside the
      // open card so it can say so and offer another try, instead of looking answered.
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

      // The host states the span (turnMs) when the event carries one: measured on its own
      // clock, over the whole turn, where this pane may only have watched the tail.
      //
      // `replay: true` is an ending out of the log being re-sent, not news. It still closes
      // the messages it owns (a live spinner must not survive a reload) but it may NOT
      // touch the turn: the mark it would measure from belongs to a later turn, so the
      // span it produced was a sliver — "Worked for 0s" over a chat that ran for minutes.
      finishTurn: (sessionId, stats, turnMs = 0, replay = false) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          // Nothing is still running once the turn is over, whatever the log says —
          // a tool whose result never arrived would otherwise spin on forever. Every
          // message is swept, not just the last: a tool row stays in the segment it was
          // announced in, and later text opens a new one.
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
                  // turnStartedAt is kept: the pane's summary line needs the start mark
                  // to print the span. A new turn overwrites it.
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

      // Full reset for a session whose view is rebuilt from the host's event log.
      // tasks goes too: the checklist is re-derived from the replayed TaskCreate /
      // TaskUpdate events, so keeping the old list would double every entry.
      //
      // The turn is NOT part of the log, so nothing here touches it. A reset arrives with
      // every hydrate — including a reload taken mid-turn — and clearing the flag there
      // reported a streaming turn as finished, which also took the stop control with it.
      // What the log does own is the span: it describes the turns that just went.
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

      /**
       * Rewind, shown before the host confirms it: keep everything above this prompt,
       * keep the prompt itself with the edited text, drop what followed.
       *
       * `newText` is the whole point of the operation — cutting the bubble too would
       * erase the words the user just typed and leave them watching an empty gap for
       * the round-trip. The host echoes this text back as `user_message` a moment
       * later, which replaces this stand-in with the real turn.
       */
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

      // TaskCreate/TaskUpdate → fold into the session's checklist. The rules live in
      // lib/taskList.js so the replay path lands the same list — see there.
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

      // Batch hydration: replaces the entire message history and task checklist in ONE      // state update instead of dispatching 5000+ individual actions on join/reconnect.
      // A gate the host did not replay is one nobody is waiting on. The caller sets it
      // back when the replay DOES carry a pending request — dropping it there instead
      // left the card from before a reload on screen, and its "answered" report went to
      // a request id the CLI had already moved past.
      hydrateSession: (sessionId, { messages = [], tasks = [], isTurnRunning = false, metadata = {}, stats = null, permissionMode = null, activeBlocked = null, elapsedMs = 0, lastTurnMs = 0, harnessTasks = null }) => {
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                activePermission: null,
                messages,
                tasks,
                isTurnRunning,
                // The host's own duration anchors the mark, so a turn rejoined mid-flight
                // shows the whole turn rather than counting from this page load. A host
                // that states none (an older agent) still gets a usable clock.
                turnStartedAt: isTurnRunning ? Date.now() - (elapsedMs || 0) : 0,
                // A turn that ended while this pane was away: the summary line reads its
                // span from here (see AiTurnStatus). 0 while one is running — the pane
                // freezes its own span on the falling edge.
                lastTurnMs: isTurnRunning ? 0 : (lastTurnMs || 0),
                // No baseline from the replay either: a mid-turn rejoin shows the session
                // total rather than pretending to know where this turn began.
                turnBaseline: isTurnRunning
                  ? { inputTokens: 0, outputTokens: 0 }
                  : { inputTokens: stats?.inputTokens || 0, outputTokens: stats?.outputTokens || 0 },
                metadata: { ...curr.metadata, ...metadata },
                stats: stats ? { ...curr.stats, ...stats } : curr.stats,
                // Authoritative from the replay: a blocked card with no matching event
                // in the log is stale and must not survive the reload.
                activeBlocked,
                ...(permissionMode ? { permissionMode } : {}),
                // What the replay's own records rebuilt. Only when the caller sent one:
                // an older agent's ack carries none, and blanking there would erase the
                // list the live path had already folded.
                ...(harnessTasks ? { harnessTasks } : {})
              }
            }
          };
        });
      },

      // Scroll-up history fetch: older turns reduced on the client, dropped in front
      // of the window already mounted. Tasks are left alone — a checklist is state,
      // not timeline, and re-deriving it here would duplicate what is already shown.
      prependMessages: (sessionId, older) => {
        if (!older?.length) return;
        set((state) => {
          const curr = sessionOf(state, sessionId);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: [...older, ...curr.messages] }
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
              metadata: { model: sess?.metadata?.model || "" }
            }
          ])
        )
      })
    }
  )
);
