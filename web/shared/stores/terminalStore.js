"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MAX_LIVE_PANES, SIDEBAR_WIDTH, RIGHT_PANEL_WIDTH, EDITOR_PANEL_WIDTH, PANE_WIDTH, DESKTOP_BREAKPOINT, TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY
} from "@/features/terminal/constants/terminalConfig";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer.js";
import { UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";
import { OVERLAY_VIEWS } from "@/features/terminal/constants/routeConfig";

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

      // TUI agent CLIs detected by the agent (new-terminal modal). agentClisAt =
      // fetch timestamp for the TTL gate in useAgentClis. Not persisted.
      agentClis: null,
      agentClisAt: 0,
      setAgentClis: (list) => set({ agentClis: Array.isArray(list) ? list : [], agentClisAt: Date.now() }),

      // Which agent CLI each session was launched with (sessionId -> agentId). The host
      // doesn't track it, so the client records it at create time. Persisted so the
      // mobile status strip can show that CLI's quota after a reload.
      agentBySession: {},
      setSessionAgent: (sessionId, agentId) => set((state) => ({
        agentBySession: { ...state.agentBySession, [sessionId]: agentId }
      })),

      // One-shot startup command per session (agent CLI launch). Consumed once by
      // the join ack in termJoin — a rejoin must never re-run it. Not persisted.
      pendingStartup: {},
      queueStartup: (sessionId, cmd) => set((state) => ({
        pendingStartup: { ...state.pendingStartup, [sessionId]: cmd }
      })),
      consumeStartup: (sessionId) => {
        const cmd = get().pendingStartup[sessionId];
        if (cmd === undefined) return null;
        set((state) => {
          const { [sessionId]: _, ...rest } = state.pendingStartup;
          return { pendingStartup: rest };
        });
        return cmd;
      },

      // Terminal font size override (null = use config defaults 14/12). Clamped: 10-16 mobile, 10-18 desktop.
      fontSize: null,
      setFontSize: (size) => set({ fontSize: size ? Math.max(10, Math.min(18, Math.round(size))) : null }),

      // Terminal palette sub-theme (default = Vesper). Resolved against app mode in useXTerm.
      terminalTheme: "default",
      setTerminalTheme: (key) => set({ terminalTheme: key || "default" }),

      // Selected terminal background pool (ordered keys, e.g. ["art1", "custom:abc"]).
      // Pane i in display order renders keys[i % len] — round-robin by panel index.
      terminalBackgrounds: [],
      setTerminalBackgrounds: (keys) => set({ terminalBackgrounds: Array.isArray(keys) ? keys.filter(Boolean) : [] }),

      // Veil opacity over the background image (null = config default). Persisted.
      terminalBackgroundOpacity: null,
      setTerminalBackgroundOpacity: (v) => set({
        terminalBackgroundOpacity: v == null
          ? TERMINAL_BG_ALPHA
          : Number((Math.max(TERMINAL_BG_OPACITY.min, Math.min(TERMINAL_BG_OPACITY.max, Math.round(v / TERMINAL_BG_OPACITY.step) * TERMINAL_BG_OPACITY.step)).toFixed(2)))
      }),

      // Agent-saved custom backgrounds ([{id, dataUrl}]). Not persisted — refetched
      // via bg:list on connect so the agent stays the source of truth (and localStorage stays light).
      customBackgrounds: [],
      setCustomBackgrounds: (items) => set({ customBackgrounds: Array.isArray(items) ? items.filter((it) => it?.id && it?.dataUrl) : [] }),

      // Per-pane quick-action button visibility (folder / git / note). Default all on.
      showFolderButton: true,
      showGitButton: true,
      showNoteButton: true,
      setShowFolderButton: (v) => set({ showFolderButton: !!v }),
      setShowGitButton: (v) => set({ showGitButton: !!v }),
      setShowNoteButton: (v) => set({ showNoteButton: !!v }),

      // User-added note suggestion chips on top of NOTE_SUGGESTIONS. Persisted.
      noteChips: [],
      addNoteChip: (text) => set((state) => ({ noteChips: [...state.noteChips, text] })),
      removeNoteChip: (text) => set((state) => ({ noteChips: state.noteChips.filter((c) => c !== text) })),

      // Which sessions keep the checklist pinned above their terminal. Persisted, so a
      // pane remounted by the LRU (or a page reload) comes back with its strip.
      pinnedNotes: {},
      setNotePinned: (sessionId, pinned) => set((state) => {
        const next = { ...state.pinnedNotes };
        if (pinned) next[sessionId] = true;
        else delete next[sessionId];
        return { pinnedNotes: next };
      }),

      // Desktop sidebar collapse (terminal view). Persisted.
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: !!v }),

      // Desktop sidebar width (px). Persisted.
      sidebarWidth: SIDEBAR_WIDTH.default,
      setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_WIDTH) }),

      // Pane width per workspace (px). null/missing = auto: panes split the row evenly
      // down to PANE_WIDTH.min; a dragged number pins them all to that fixed width.
      paneWidths: {},
      setPaneWidth: (workspaceId, w) => set((state) => ({
        paneWidths: { ...state.paneWidths, [workspaceId]: w == null ? null : clampWidth(w, PANE_WIDTH) }
      })),

      // Right panel (file tree / git / worktrees). Open by default on desktop only —
      // on mobile it is a full-screen overlay over the terminal. Persisted (desktop).
      rightPanelOpen: typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT,
      // Per-workspace tab choice: switching workspace restores its own files/git tab.
      rightPanelTabs: {},
      rightPanelWidth: RIGHT_PANEL_WIDTH.default,
      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      closeRightPanel: () => set({ rightPanelOpen: false }),
      openRightPanel: () => set({ rightPanelOpen: true }),
      setRightPanelTab: (tab, workspacePath) => set((state) => ({
        rightPanelOpen: true,
        // "" is the shared slot for a workspace-less panel — the tab must still switch.
        ...(workspacePath != null ? { rightPanelTabs: { ...state.rightPanelTabs, [workspacePath]: tab } } : {})
      })),

      // Per-workspace root override for the side panel: a pane's folder button reveals
      // the terminal's live cwd (OSC 7) as a snapshot — later `cd` must not move the tree.
      // Dropping the key (root back at the workspace path) deletes the override.
      rightPanelRoots: {},
      setRightPanelRoot: (workspacePath, rootPath) => set((state) => {
        if (workspacePath == null) return state;
        const next = { ...state.rightPanelRoots };
        if (!rootPath || rootPath === workspacePath) delete next[workspacePath];
        else next[workspacePath] = rootPath;
        return { rightPanelRoots: next };
      }),
      setRightPanelWidth: (w) => set({ rightPanelWidth: clampWidth(w, RIGHT_PANEL_WIDTH) }),

      // Inline editor opened from the tree. A flex sibling of the panes row — panes keep
      // their width (the row scrolls), so it never collapses the sidebar or resizes PTYs.
      editorFilePath: null,
      editorPanelWidth: EDITOR_PANEL_WIDTH.default,
      setEditorPanelWidth: (w) => set({ editorPanelWidth: clampWidth(w, EDITOR_PANEL_WIDTH) }),
      // Bumped seq, not a boolean: reopening the same file must re-trigger preview.
      editorPreviewSeq: 0,
      openEditorFile: (filePath, opts = {}) => set((st) => ({
        editorFilePath: filePath,
        editorPreviewSeq: opts.preview ? st.editorPreviewSeq + 1 : 0
      })),
      closeEditorFile: () => set({ editorFilePath: null, editorPreviewSeq: 0 }),


      // Actions
      // A non-overlay view replaces a trailing overlay (site browser) instead of
      // stacking on it — the overlay has no URL entry, so it must never be buried.
      pushView: (view) => set((state) => {
        const stack = Array.isArray(state.viewStack) ? state.viewStack : [];
        const base = OVERLAY_VIEWS.includes(view?.type)
          ? stack
          : stack.filter((v, i) => !(OVERLAY_VIEWS.includes(v?.type) && i === stack.length - 1));
        return { viewStack: [...base, view] };
      }),

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
        const { [sessionId]: __, ...startups } = state.pendingStartup;
        return {
          openedSessions: state.openedSessions.filter(id => id !== sessionId),
          livePanes: state.livePanes.filter(id => id !== sessionId),
          drafts,
          pendingStartup: startups
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
        agentBySession: state.agentBySession,
        activeWorkspaceId: state.activeWorkspaceId,
        collapsedWorkspaces: state.collapsedWorkspaces,
        webglEnabled: state.webglEnabled,
        fontSize: state.fontSize,
        terminalTheme: state.terminalTheme,
        terminalBackgrounds: state.terminalBackgrounds,
        terminalBackgroundOpacity: state.terminalBackgroundOpacity,
        showFolderButton: state.showFolderButton,
        showGitButton: state.showGitButton,
        showNoteButton: state.showNoteButton,
        noteChips: state.noteChips,
        pinnedNotes: state.pinnedNotes,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        paneWidths: state.paneWidths,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelTabs: state.rightPanelTabs,
        rightPanelRoots: state.rightPanelRoots,
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
        // Overlay views aren't in the URL — a reload must not restore them on top
        state.viewStack = state.viewStack.filter((v) => !OVERLAY_VIEWS.includes(v?.type));
        if (state.viewStack.length === 0) state.viewStack = [{ type: "list" }];
        // Legacy single-preset state migrates into the ordered pool
        if (!Array.isArray(state.terminalBackgrounds)) state.terminalBackgrounds = [];
        if (state.terminalBackground && state.terminalBackground !== "none" && state.terminalBackgrounds.length === 0) {
          state.terminalBackgrounds = [state.terminalBackground];
        }
        // Mobile: the panel overlays the terminal — never restore it open
        if (window.innerWidth < DESKTOP_BREAKPOINT) state.rightPanelOpen = false;
      }
    }
  )
);
