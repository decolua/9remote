"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MAX_LIVE_PANES } from "@/features/terminal/constants/terminalConfig";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer.js";

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

      // Groups whose panes have been mounted (xterm initialized) at least once. Drives lazy
      // per-group mounting: only the active group mounts on first visit (sequential, focus first),
      // other groups stay as placeholders until visited. Keeps mounted panes alive on revisit.
      // Key: groupId, or null stringified as "__ungrouped__". Not persisted.
      mountedGroups: {},
      markGroupMounted: (groupId) => set((state) => {
        const key = groupId ?? "__ungrouped__";
        if (state.mountedGroups[key]) return state; // already mounted — no re-render
        return { mountedGroups: { ...state.mountedGroups, [key]: true } };
      }),
      isGroupMounted: (groupId) => {
        const key = groupId ?? "__ungrouped__";
        return !!get().mountedGroups[key];
      },

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
      setCwd: (sessionId, cwd) => {
        if (!sessionId || !cwd) return;
        // OSC 7 cwd arrives OS-native (\\ on Windows) — normalize for web path helpers.
        const norm = toPosixPath(cwd);
        set((state) => state.cwdBySession[sessionId] === norm ? state : ({ cwdBySession: { ...state.cwdBySession, [sessionId]: norm } }));
      },

      // WebGL renderer toggle (default on; off → canvas fallback). Applied on next mount.
      webglEnabled: true,
      setWebglEnabled: (enabled) => set({ webglEnabled: !!enabled }),

      // Agent capability flags from serverInfo.caps — feature-detect new payload shapes
      // so web doesn't break against an older agent (e.g. joinSession with cols/rows).
      agentCaps: {},
      setAgentCaps: (caps) => set({ agentCaps: caps || {} }),

      // Terminal font size override (null = use config defaults 14/12). Clamped: 10-16 mobile, 10-18 desktop.
      fontSize: null,
      setFontSize: (size) => set({ fontSize: size ? Math.max(10, Math.min(18, Math.round(size))) : null }),

      // Terminal palette sub-theme (default = Vesper). Resolved against app mode in useXTerm.
      terminalTheme: "default",
      setTerminalTheme: (key) => set({ terminalTheme: key || "default" }),

      // Per-pane quick-action button visibility (folder / git / note). Default all on.
      showFolderButton: true,
      showGitButton: true,
      showNoteButton: true,
      setShowFolderButton: (v) => set({ showFolderButton: !!v }),
      setShowGitButton: (v) => set({ showGitButton: !!v }),
      setShowNoteButton: (v) => set({ showNoteButton: !!v }),
      
      // Actions
      pushView: (view) => set((state) => ({
        viewStack: [...(Array.isArray(state.viewStack) ? state.viewStack : []), view]
      })),

      popView: () => set((state) => {
        const stack = Array.isArray(state.viewStack) ? state.viewStack : [];
        return {
          viewStack: stack.length > 1 ? stack.slice(0, -1) : stack
        };
      }),
      
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
        webglEnabled: state.webglEnabled,
        fontSize: state.fontSize,
        terminalTheme: state.terminalTheme,
        showFolderButton: state.showFolderButton,
        showGitButton: state.showGitButton,
        showNoteButton: state.showNoteButton
      }),
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          try {
            const value = localStorage.getItem(name);
            if (!value) return null;
            const parsed = JSON.parse(value);
            // Sanitize corrupted persisted viewStack (non-array or empty)
            if (parsed && !Array.isArray(parsed.viewStack)) parsed.viewStack = [{ type: "list" }];
            return parsed;
          } catch {
            // Corrupted storage must not blank the app — start from defaults
            return null;
          }
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          // Quota exceeded / private mode throws — persistence is best-effort
          try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          localStorage.removeItem(name);
        }
      },
      // Normalize corrupted persisted state (e.g. viewStack null/non-array)
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.viewStack) || state.viewStack.length === 0) {
          state.viewStack = [{ type: "list" }];
        }
      }
    }
  )
);
