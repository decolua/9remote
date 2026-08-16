"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MAX_LIVE_PANES, SIDEBAR_WIDTH, RIGHT_PANEL_WIDTH, EDITOR_PANEL_WIDTH
} from "@/features/terminal/constants/terminalConfig";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer.js";
import { UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";

const clampWidth = (w, { min, max }) => Math.max(min, Math.min(max, Math.round(w)));

// Terminal UI state store - persisted to sessionStorage
export const useTerminalStore = create(
  persist(
    (set, get) => ({
      // Navigation stack
      viewStack: [{ type: "list" }],
      openedSessions: [],

      // Active workspace for terminal-view tab filtering (null = Ungrouped)
      activeWorkspaceId: null,
      setActiveWorkspaceId: (workspaceId) => set({ activeWorkspaceId: workspaceId }),

      // LRU of session ids kept mounted (alive) across workspace switches. Not persisted.
      livePanes: [],
      // Mark session(s) as recently used; keep at most MAX_LIVE_PANES (evict oldest)
      touchLivePane: (sessionIds) => set((state) => {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        const next = [...state.livePanes.filter(id => !ids.includes(id)), ...ids];
        return { livePanes: next.slice(-MAX_LIVE_PANES) };
      }),

      // Workspaces whose panes have been mounted (xterm initialized) at least once. Drives lazy
      // per-workspace mounting: only the active workspace mounts on first visit (sequential, focus
      // first), others stay as placeholders until visited. Keeps mounted panes alive on revisit.
      // Key: workspaceId, or null stringified as UNGROUPED_KEY. Not persisted.
      mountedWorkspaces: {},
      markWorkspaceMounted: (workspaceId) => set((state) => {
        const key = workspaceId ?? UNGROUPED_KEY;
        if (state.mountedWorkspaces[key]) return state; // already mounted — no re-render
        return { mountedWorkspaces: { ...state.mountedWorkspaces, [key]: true } };
      }),
      isWorkspaceMounted: (workspaceId) => {
        const key = workspaceId ?? UNGROUPED_KEY;
        return !!get().mountedWorkspaces[key];
      },

      // Unsent MobileKeyboard draft text, keyed by sessionId. Lives here (not in the
      // component) so it survives MobileKeyboard unmounting when switching to remote/etc.
      drafts: {},
      setDraft: (sessionId, text) => set((state) => ({
        drafts: { ...state.drafts, [sessionId]: text }
      })),

      // Collapsed accordion workspaces in SessionList (key by workspaceId, "ungrouped" for null)
      collapsedWorkspaces: {},
      toggleWorkspace: (key) => set((state) => ({
        collapsedWorkspaces: { ...state.collapsedWorkspaces, [key]: !state.collapsedWorkspaces[key] }
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

      // Desktop sidebar collapse (terminal view). Persisted.
      sidebarCollapsed: false,
      // Toggling by hand takes ownership back from the editor, so closing the editor
      // later does not undo the user's own choice.
      toggleSidebar: () => set((state) => ({
        sidebarCollapsed: !state.sidebarCollapsed,
        sidebarCollapsedByEditor: false
      })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: !!v, sidebarCollapsedByEditor: false }),

      // Desktop sidebar width (px). Persisted.
      sidebarWidth: SIDEBAR_WIDTH.default,
      setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_WIDTH) }),

      // Right panel (file tree / git / worktrees). Hidden by default — it costs horizontal
      // space the terminal needs. Persisted.
      rightPanelOpen: false,
      rightPanelTab: "files",
      rightPanelWidth: RIGHT_PANEL_WIDTH.default,
      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setRightPanelTab: (tab) => set({ rightPanelOpen: true, rightPanelTab: tab }),
      setRightPanelWidth: (w) => set({ rightPanelWidth: clampWidth(w, RIGHT_PANEL_WIDTH) }),

      // Inline editor opened from the tree. Opening it collapses the left sidebar and
      // remembers whether the user had it open, so closing restores their layout.
      editorFilePath: null,
      editorPanelWidth: EDITOR_PANEL_WIDTH.default,
      sidebarCollapsedByEditor: false,
      setEditorPanelWidth: (w) => set({ editorPanelWidth: clampWidth(w, EDITOR_PANEL_WIDTH) }),
      openEditorFile: (filePath) => set((state) => ({
        editorFilePath: filePath,
        sidebarCollapsed: true,
        sidebarCollapsedByEditor: state.editorFilePath ? state.sidebarCollapsedByEditor : !state.sidebarCollapsed
      })),
      closeEditorFile: () => set((state) => ({
        editorFilePath: null,
        sidebarCollapsed: state.sidebarCollapsedByEditor ? false : state.sidebarCollapsed,
        sidebarCollapsedByEditor: false
      })),


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
        activeWorkspaceId: null
      })
    }),
    {
      name: "terminal-ui-state",
      partialize: (state) => ({
        viewStack: state.viewStack,
        openedSessions: state.openedSessions,
        activeWorkspaceId: state.activeWorkspaceId,
        collapsedWorkspaces: state.collapsedWorkspaces,
        webglEnabled: state.webglEnabled,
        fontSize: state.fontSize,
        terminalTheme: state.terminalTheme,
        showFolderButton: state.showFolderButton,
        showGitButton: state.showGitButton,
        showNoteButton: state.showNoteButton,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelTab: state.rightPanelTab,
        rightPanelWidth: state.rightPanelWidth,
        editorPanelWidth: state.editorPanelWidth
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
