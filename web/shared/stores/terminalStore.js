"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MAX_LIVE_PANES } from "@/features/terminal/constants/terminalConfig";

// Terminal UI state store - persisted to sessionStorage
export const useTerminalStore = create(
  persist(
    (set, get) => ({
      // Navigation stack
      viewStack: [{ type: "list" }],
      openedSessions: [],

      // Active group for terminal-view tab filtering (null = Ungrouped)
      activeGroupId: null,
      setActiveGroupId: (groupId) => set({ activeGroupId: groupId }),

      // LRU of session ids kept mounted (alive) across group switches. Not persisted.
      livePanes: [],
      // Mark session(s) as recently used; keep at most MAX_LIVE_PANES (evict oldest)
      touchLivePane: (sessionIds) => set((state) => {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        const next = [...state.livePanes.filter(id => !ids.includes(id)), ...ids];
        return { livePanes: next.slice(-MAX_LIVE_PANES) };
      }),

      // Unsent MobileKeyboard draft text, keyed by sessionId. Lives here (not in the
      // component) so it survives MobileKeyboard unmounting when switching to remote/etc.
      drafts: {},
      setDraft: (sessionId, text) => set((state) => ({
        drafts: { ...state.drafts, [sessionId]: text }
      })),

      // Collapsed accordion groups in SessionList (key by groupId, "ungrouped" for null)
      collapsedGroups: {},
      toggleGroup: (key) => set((state) => ({
        collapsedGroups: { ...state.collapsedGroups, [key]: !state.collapsedGroups[key] }
      })),

      // Per-session working directory (OSC 7), consumed by path-aware suggestions.
      cwdBySession: {},
      setCwd: (sessionId, cwd) => { if (!sessionId || !cwd) return; set((state) => state.cwdBySession[sessionId] === cwd ? state : ({ cwdBySession: { ...state.cwdBySession, [sessionId]: cwd } })); },

      // WebGL renderer toggle (default on; off → canvas fallback). Applied on next mount.
      webglEnabled: true,
      setWebglEnabled: (enabled) => set({ webglEnabled: !!enabled }),

      // Terminal font size override (null = use config defaults 14/12). Clamped: 10-16 mobile, 10-18 desktop.
      fontSize: null,
      setFontSize: (size) => set({ fontSize: size ? Math.max(10, Math.min(18, Math.round(size))) : null }),
      
      // Actions
      pushView: (view) => set((state) => ({
        viewStack: [...state.viewStack, view]
      })),
      
      popView: () => set((state) => ({
        viewStack: state.viewStack.length > 1 
          ? state.viewStack.slice(0, -1) 
          : state.viewStack
      })),
      
      setViewStack: (viewStack) => set({ viewStack }),
      
      addOpenedSession: (sessionId) => set((state) => ({
        openedSessions: state.openedSessions.includes(sessionId)
          ? state.openedSessions
          : [...state.openedSessions, sessionId]
      })),
      
      removeOpenedSession: (sessionId) => set((state) => {
        const { [sessionId]: _, ...drafts } = state.drafts;
        return {
          openedSessions: state.openedSessions.filter(id => id !== sessionId),
          livePanes: state.livePanes.filter(id => id !== sessionId),
          drafts
        };
      }),
      
      clearOpenedSessions: () => set({ openedSessions: [], livePanes: [] }),
      
      // Get current view
      getCurrentView: () => {
        const { viewStack } = get();
        return viewStack[viewStack.length - 1];
      },
      
      // Get selected session from stack
      getSelectedSession: () => {
        const { viewStack } = get();
        for (let i = viewStack.length - 1; i >= 0; i--) {
          if (viewStack[i].type === "terminal") return viewStack[i].sessionId;
        }
        return null;
      },
      
      // Reset to initial state
      reset: () => set({
        viewStack: [{ type: "list" }],
        openedSessions: [],
        livePanes: [],
        activeGroupId: null
      })
    }),
    {
      name: "terminal-ui-state",
      partialize: (state) => ({
        viewStack: state.viewStack,
        openedSessions: state.openedSessions,
        activeGroupId: state.activeGroupId,
        collapsedGroups: state.collapsedGroups,
        webglEnabled: state.webglEnabled
      }),
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const value = sessionStorage.getItem(name);
          return value ? JSON.parse(value) : null;
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          sessionStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          sessionStorage.removeItem(name);
        }
      }
    }
  )
);
