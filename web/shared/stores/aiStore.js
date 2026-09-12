"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { updateToolTree, settleRunningTools } from "@/features/ai/lib/toolTree";

const INITIAL_SESSION_STATE = {
  messages: [],
  isTurnRunning: false,
  // Client clock at the moment the turn started — drives the AI pane's turn status
  // line. The host sends no timestamp, so a reconnect mid-turn restarts the count.
  turnStartedAt: 0,
  activePermission: null,
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
};

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

      setPermissionMode: (sessionId, mode) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, stats: { ...curr.stats, ...stats } }
            }
          };
        });
      },

      addUserMessage: (sessionId, text, attachments = null) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const userMsg = { id: `u-${Date.now()}`, role: "user", content: text, attachments: attachments || [] };
          const assistantPlaceholder = {
            id: `a-${Date.now()}`,
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
                isTurnRunning: true,
                turnStartedAt: Date.now(),
                // The counter on screen is this turn's own usage, so it starts at zero
                // every prompt: remember where the session total stood.
                turnBaseline: {
                  inputTokens: curr.stats.inputTokens || 0,
                  outputTokens: curr.stats.outputTokens || 0
                },
                activeBlocked: null,
                messages: [...curr.messages, userMsg, assistantPlaceholder]
              }
            }
          };
        });
      },

      appendDelta: (sessionId, text) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const list = [...curr.messages];
          const last = list[list.length - 1];
          if (!last || last.role !== "assistant" || !last.isLive) {
            list.push({ id: `msg-${Date.now()}`, role: "assistant", content: text || "", isLive: true, diffs: [], tools: [] });
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const list = [...curr.messages];
          const last = list[list.length - 1];
          if (!last || last.role !== "assistant" || !last.isLive) {
            list.push({ id: `msg-${Date.now()}`, role: "assistant", content: "", thinking: text || "", isLive: true, diffs: [], tools: [] });
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const list = [...curr.messages];
          let last = list[list.length - 1];
          if (!last || last.role !== "assistant") {
            last = { id: `msg-${Date.now()}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const list = [...curr.messages];
          const last = list[list.length - 1];
          // Text/thinking already streamed in this segment → close it and open a new
          // segment so tools interleave with text in arrival order (CLI timeline feel)
          if (last && last.role === "assistant" && last.isLive && ((last.content || last.thinking || "").length > 0)) {
            list[list.length - 1] = { ...last, isLive: false };
            list.push({
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: "",
              isLive: true,
              diffs: [],
              tools: [{ ...toolData, status: toolData.status || "running" }]
            });
          } else if (!last || last.role !== "assistant") {
            list.push({
              id: `msg-${Date.now()}`,
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activePermission: permission }
            }
          };
        });
      },

      clearPermission: (sessionId) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, activeBlocked: null }
            }
          };
        });
      },

      finishTurn: (sessionId, stats) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
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
                isTurnRunning: false,
                // turnStartedAt is kept: the pane's summary line needs the start mark
                // to print the span. A new turn overwrites it.
                activePermission: null,
                stats: stats ? { ...curr.stats, ...stats } : curr.stats,
                messages
              }
            }
          };
        });
      },

      // Full reset for a session whose view is rebuilt from the host's event log.
      // tasks goes too: the checklist is re-derived from the replayed TaskCreate /
      // TaskUpdate events, so keeping the old list would double every entry.
      clearMessages: (sessionId) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages: [],
                tasks: [],
                isTurnRunning: false,
                turnStartedAt: 0,
                activePermission: null,
                activeBlocked: null,
                stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
                turnBaseline: { inputTokens: 0, outputTokens: 0 }
              }
            }
          };
        });
      },

      rewindToMessage: (sessionId, messageId, newText) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const idx = curr.messages.findIndex((m) => m.id === messageId);
          if (idx === -1) return state;
          // Truncate only: the host echoes the resubmitted text back as `user_message`,
          // so adding it here too would render the same prompt twice.
          const messages = curr.messages.slice(0, idx);
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages,
                isTurnRunning: false,
                turnStartedAt: 0,
                activePermission: null
              }
            }
          };
        });
      },

      // TaskCreate/TaskUpdate → upsert into session tasks list
      upsertTask: (sessionId, taskData) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          // TodoWrite carries the whole list — it replaces, never appends
          if (taskData.replaceAll) {
            return {
              bySession: {
                ...state.bySession,
                [sessionId]: { ...curr, tasks: taskData.todos || [] }
              }
            };
          }
          const tasks = [...(curr.tasks || [])];
          const targetId = String(taskData.taskId || taskData.id || "");
          const idx = tasks.findIndex(
            (t, i) =>
              (t.id && String(t.id) === targetId) ||
              (t.taskId && String(t.taskId) === targetId) ||
              String(i + 1) === targetId
          );
          if (idx !== -1) {
            tasks[idx] = { ...tasks[idx], ...taskData };
          } else if (taskData.subject) {
            tasks.push(taskData);
          }
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, tasks }
            }
          };
        });
      },

      // Batch hydration: replaces the entire message history and task checklist in ONE
      // state update instead of dispatching 5000+ individual actions on join/reconnect.
      hydrateSession: (sessionId, { messages = [], tasks = [], isTurnRunning = false, metadata = {}, stats = null, permissionMode = null, activeBlocked = null }) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages,
                tasks,
                isTurnRunning,
                // Replay has no start time — a turn rejoined mid-flight counts from now.
                turnStartedAt: isTurnRunning ? Date.now() : 0,
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
                ...(permissionMode ? { permissionMode } : {})
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
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: { ...curr, messages: [...older, ...curr.messages] }
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
