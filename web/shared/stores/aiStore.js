"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

const INITIAL_SESSION_STATE = {
  messages: [],
  isTurnRunning: false,
  activePermission: null,
  permissionMode: "default",
  stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
  metadata: { model: "", skills: [], mcpServers: [] },
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

      addUserMessage: (sessionId, text) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const userMsg = { id: `u-${Date.now()}`, role: "user", content: text };
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

      finishTurn: (sessionId, stats) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          const messages = curr.messages.map((m, idx) => (idx === curr.messages.length - 1 ? { ...m, isLive: false } : m));
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                isTurnRunning: false,
                activePermission: null,
                stats: stats ? { ...curr.stats, ...stats } : curr.stats,
                messages
              }
            }
          };
        });
      },

      clearMessages: (sessionId) => {
        set((state) => {
          const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
          return {
            bySession: {
              ...state.bySession,
              [sessionId]: {
                ...curr,
                messages: [],
                isTurnRunning: false,
                activePermission: null,
                stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 }
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
      partialize: (state) => ({
        bySession: Object.fromEntries(
          Object.entries(state.bySession).map(([sid, sess]) => [
            sid,
            {
              ...sess,
              isTurnRunning: false,
              activePermission: null,
              messages: (sess.messages || []).map((m) => ({ ...m, isLive: false }))
            }
          ])
        )
      })
    }
  )
);
