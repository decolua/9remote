"use client";

import { create } from "zustand";

const INITIAL_SESSION_STATE = {
  messages: [],
  isTurnRunning: false,
  stats: { inputTokens: 0, outputTokens: 0, totalTurns: 0, totalCost: 0, reasoningTokens: 0 },
  metadata: { model: "" },
};

export const useAiStore = create((set, get) => ({
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
      let last = list[list.length - 1];
      if (!last || last.role !== "assistant" || !last.isLive) {
        last = { id: `msg-${Date.now()}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
        list.push(last);
      }
      last.content = (last.content || "") + (text || "");
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
      let last = list[list.length - 1];
      if (!last || last.role !== "assistant" || !last.isLive) {
        last = { id: `msg-${Date.now()}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
        list.push(last);
      }
      last.thinking = (last.thinking || "") + (text || "");
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
      }
      last.diffs = [...(last.diffs || []), diffData];
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
      let last = list[list.length - 1];
      if (!last || last.role !== "assistant") {
        last = { id: `msg-${Date.now()}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
        list.push(last);
      }
      last.tools = [...(last.tools || []), { ...toolData, status: "running" }];
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
      const last = list[list.length - 1];
      if (last && last.tools) {
        last.tools = last.tools.map((t) => (t.id === resultData.id ? { ...t, ...resultData, status: "done" } : t));
      } else if (last) {
        last.tools = [{ ...resultData, status: "done" }];
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
      const list = [...curr.messages];
      let last = list[list.length - 1];
      if (!last || last.role !== "assistant") {
        last = { id: `msg-${Date.now()}`, role: "assistant", content: "", isLive: true, diffs: [], tools: [] };
        list.push(last);
      }
      last.permission = permission;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...curr, messages: list }
        }
      };
    });
  },

  clearPermission: (sessionId, requestId) => {
    set((state) => {
      const curr = state.bySession[sessionId] || INITIAL_SESSION_STATE;
      const list = curr.messages.map((m) => (m.permission?.requestId === requestId ? { ...m, permission: null } : m));
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...curr, messages: list }
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
            stats: stats ? { ...curr.stats, ...stats } : curr.stats,
            messages
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
}));
