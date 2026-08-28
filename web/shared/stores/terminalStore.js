"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MAX_LIVE_PANES, SIDEBAR_WIDTH, RIGHT_PANEL_WIDTH, EDITOR_PANEL_WIDTH, MOBILE_PANEL_WIDTH, PANE_WIDTH, DESKTOP_BREAKPOINT, TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY, ARTIFACT_STACK_MAX, PERSIST_DEBOUNCE_MS
} from "@/features/terminal/constants/terminalConfig";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer.js";
import { UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";
import { OVERLAY_VIEWS } from "@/features/terminal/constants/routeConfig";

const clampWidth = (w, { min, max }) => Math.max(min, Math.min(max, Math.round(w)));

// Coalesced localStorage writer. persist re-serializes the whole partialized state on every
// set(), so a splitter drag or a typed draft would stringify + write synchronously per event.
// The value in memory is always current; only the write to disk trails it.
const pendingWrite = { name: null, value: null };
let writeTimer = null;

const flushWrite = () => {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (pendingWrite.name === null) return;
  const { name, value } = pendingWrite;
  pendingWrite.name = null;
  pendingWrite.value = null;
  // Quota exceeded / private mode throws — persistence is best-effort
  try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
};

// A backgrounded tab may never run another timer, so the pending write lands here instead.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWrite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWrite();
  });
}

// Drop one artifact, and the session's entry with it once empty — a map that only ever
// grows would keep every closed terminal alive in storage.
const dropArtifact = (bySession, sessionId, filePath) => {
  const list = bySession[sessionId];
  if (!list) return bySession;
  const next = list.filter((a) => a.path !== filePath);
  if (next.length === list.length) return bySession;
  const { [sessionId]: _, ...rest } = bySession;
  return next.length ? { ...rest, [sessionId]: next } : rest;
};

// Mark every cwd's agent-history rows as due for a refetch, optionally rewriting
// them on the way out. Only the agent knows which terminal runs which
// conversation, so an answer that may have changed is backdated rather than
// dropped: the panel keeps rendering while the next poll re-asks.
const staleAgentHistory = (history, mapRow) => {
  const next = {};
  for (const [cwd, entry] of Object.entries(history)) {
    next[cwd] = { at: 0, sessions: mapRow ? entry.sessions.map(mapRow) : entry.sessions };
  }
  return next;
};

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
      // Mirrors the agent's own setting (it owns the CLI config files); serverInfo
      // re-sends it after every change, so this is a cache, not a second truth.
      artifactEnabled: false,
      setArtifactEnabled: (enabled) => set({ artifactEnabled: !!enabled }),
      // AI CLI ids the agent writes the MCP entry into, named in the settings screen.
      mcpClients: [],
      setMcpClients: (ids) => set({ mcpClients: Array.isArray(ids) ? ids : [] }),

      // TUI agent CLIs detected by the agent (new-terminal modal). agentClisAt =
      // fetch timestamp for the TTL gate in useAgentClis. Not persisted.
      agentClis: null,
      agentClisAt: 0,
      setAgentClis: (list) => set({ agentClis: Array.isArray(list) ? list : [], agentClisAt: Date.now() }),

      // Past conversations of the agent CLIs, keyed by the cwd they ran in — a
      // terminal that cd's elsewhere asks a different question, so the cwd is
      // the cache key rather than the session. Not persisted.
      agentHistory: {},
      setAgentHistory: (cwd, sessions) => set((state) => ({
        agentHistory: { ...state.agentHistory, [cwd]: { at: Date.now(), sessions: Array.isArray(sessions) ? sessions : [] } }
      })),

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
      terminalBackgrounds: ["art8"],
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
      showNoteButton: true,
      setShowFolderButton: (v) => set({ showFolderButton: !!v }),
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
      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen, rightPanelWasOpen: null })),
      closeRightPanel: () => set({ rightPanelOpen: false, rightPanelWasOpen: null }),
      openRightPanel: () => set({ rightPanelOpen: true, rightPanelWasOpen: null }),
      setRightPanelTab: (tab, workspacePath) => set((state) => ({
        rightPanelOpen: true,
        rightPanelWasOpen: null,
        // "" is the shared slot for a workspace-less panel — the tab must still switch.
        ...(workspacePath != null ? { rightPanelTabs: { ...state.rightPanelTabs, [workspacePath]: tab } } : {})
      })),

      // Per-workspace root override for the side panel: a pane's folder button reveals
      // the terminal's live cwd (OSC 7) as a snapshot — later `cd` must not move the tree.
      // Dropping the key (root back at the workspace path) deletes the override. Not
      // persisted: a stale reveal would survive a reload and pin the panel to an old
      // worktree while the terminal stands elsewhere.
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

      // Header buttons the user has hidden, by id. Absent = shown, so a new
      // button is visible by default rather than silently missing.
      hiddenHeaderButtons: [],
      toggleHeaderButton: (id) => set((state) => ({
        hiddenHeaderButtons: state.hiddenHeaderButtons.includes(id)
          ? state.hiddenHeaderButtons.filter((b) => b !== id)
          : [...state.hiddenHeaderButtons, id]
      })),

      // Boot AVDs without a window: about six times less host CPU, at a much
      // lower frame rate. Persisted, because it is a property of the machine
      // (thermally limited, on battery) rather than of one session.
      mobileLowPower: false,
      setMobileLowPower: (on) => set({ mobileLowPower: !!on }),

      // Devices currently up, as reported by the agent. Drives the header
      // button's active state: a windowless emulator gives no other sign that
      // it is running. Not persisted — it describes the host right now.
      mobileDeviceCount: 0,
      setMobileDeviceCount: (n) => set({ mobileDeviceCount: Number(n) || 0 }),
      // Whether the host has Android tooling at all — a machine with no adb can
      // never mirror anything, so the button is hidden rather than offered.
      mobileAvailable: false,
      setMobileAvailable: (v) => set({ mobileAvailable: !!v }),

      // Android mirror on desktop. "float" keeps the terminal full width; "pin"
      // docks it as a right-hand column. Not tied to a workspace: the device
      // outlives whatever is being edited.
      mobileOpen: false,
      mobileMode: "float",            // "float" | "pin"
      mobilePanelWidth: MOBILE_PANEL_WIDTH.default,
      mobileFloatRect: null,          // {x, y, w, h} — null until first placed
      setMobileOpen: (open) => set({ mobileOpen: !!open }),
      setMobileMode: (mode) => set({ mobileMode: mode, mobileOpen: true }),
      setMobilePanelWidth: (w) => set({ mobilePanelWidth: clampWidth(w, MOBILE_PANEL_WIDTH) }),
      setMobileFloatRect: (rect) => set({ mobileFloatRect: rect }),
      // The agent keeps mirroring regardless of where the UI shows it, so the
      // live session is remembered here: switching float/pin/pip remounts the
      // view, and re-running mobile:start would cost a needless restart.
      // Not persisted — a reload has no agent-side session to rejoin.
      mobileSession: null,          // { serial, meta } | null
      // Accepts an updater so a caller can patch one field (the agent resizing the
      // stream) without racing whatever else has changed since it read the value.
      setMobileSession: (session) => set((state) => ({
        mobileSession: typeof session === "function" ? session(state.mobileSession) : session
      })),
      // Bumped seq, not a boolean: reopening the same file must re-trigger preview.
      editorPreviewSeq: 0,
      // An artifact is the same panel opened by the AI rather than by the tree. It takes
      // the side panel's place while it is up: two panels at once leaves no room for the
      // terminal. rightPanelWasOpen remembers what to give back on close — null once the
      // user opens the side panel themselves, since that choice outranks the restore.
      artifactTitle: null,
      rightPanelWasOpen: null,
      // The terminal an open artifact belongs to, so closing the panel pops the right
      // stack — the user may well have switched terminals while it was up.
      artifactSessionId: null,
      openEditorFile: (filePath, opts = {}) => set((st) => ({
        editorFilePath: filePath,
        editorPreviewSeq: opts.preview ? st.editorPreviewSeq + 1 : 0,
        artifactTitle: opts.artifactTitle || null,
        artifactSessionId: opts.artifactSessionId || null,
        ...(opts.artifactTitle
          ? { rightPanelWasOpen: st.rightPanelWasOpen ?? st.rightPanelOpen, rightPanelOpen: false }
          : {})
      })),
      closeEditorFile: () => set((st) => ({
        editorFilePath: null,
        editorPreviewSeq: 0,
        artifactTitle: null,
        artifactSessionId: null,
        rightPanelWasOpen: null,
        ...(st.rightPanelWasOpen ? { rightPanelOpen: true } : {}),
        ...(st.artifactSessionId && st.editorFilePath
          ? { artifactsBySession: dropArtifact(st.artifactsBySession, st.artifactSessionId, st.editorFilePath) }
          : {})
      })),

      // Artifacts the AI has shown, newest first, per terminal. Persisted: the phone
      // backgrounds the app mid-run, and coming back to an empty panel loses them.
      artifactsBySession: {},
      pushArtifact: (sessionId, item) => set((st) => {
        if (!sessionId || !item?.path) return {};
        const rest = (st.artifactsBySession[sessionId] || []).filter((a) => a.path !== item.path);
        return {
          artifactsBySession: {
            ...st.artifactsBySession,
            [sessionId]: [item, ...rest].slice(0, ARTIFACT_STACK_MAX)
          }
        };
      }),
      removeArtifact: (sessionId, filePath) => set((st) => ({
        artifactsBySession: dropArtifact(st.artifactsBySession, sessionId, filePath)
      })),


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
        const { [sessionId]: ___, ...artifacts } = state.artifactsBySession;
        return {
          artifactsBySession: artifacts,
          openedSessions: state.openedSessions.filter(id => id !== sessionId),
          livePanes: state.livePanes.filter(id => id !== sessionId),
          drafts,
          pendingStartup: startups
        };
      }),
      
      clearOpenedSessions: () => set({ openedSessions: [], livePanes: [] }),

      // Reordering tabs must move the panes too. Only the ids being reordered are
      // rearranged — sessions of other workspaces keep the slots they already hold.
      reorderOpenedSessions: (orderedIds) => set((state) => {
        const moving = new Set(orderedIds);
        const queue = orderedIds.filter((id) => state.openedSessions.includes(id));
        if (queue.length < 2) return {};
        let i = 0;
        return {
          openedSessions: state.openedSessions.map((id) => (moving.has(id) ? queue[i++] : id))
        };
      }),

      // Something changed which terminal runs which conversation, and only the
      // agent knows the new answer. Backdate the rows so the next poll refetches
      // while the panel keeps rendering what it has.
      invalidateAgentHistory: () => set((state) => ({ agentHistory: staleAgentHistory(state.agentHistory) })),

      // The terminal is gone for good — everything keyed by its id goes with it.
      // Its history rows are kept and merely unlinked: the conversations still
      // exist and are still worth offering, they just aren't open anywhere now.
      // Discarding them instead would blank the panel until the next poll.
      closeSession: (sessionId) => set((state) => {
        const { [sessionId]: _draft, ...drafts } = state.drafts;
        const { [sessionId]: _startup, ...pendingStartup } = state.pendingStartup;
        const { [sessionId]: _agent, ...agentBySession } = state.agentBySession;
        // Unlinked and backdated: the rows keep rendering, and the next poll
        // re-asks the agent, which may now match one of them to another terminal.
        const agentHistory = staleAgentHistory(state.agentHistory, (row) =>
          row.openSessionId === sessionId ? { ...row, openSessionId: null } : row
        );
        return {
          openedSessions: state.openedSessions.filter(id => id !== sessionId),
          livePanes: state.livePanes.filter(id => id !== sessionId),
          drafts,
          pendingStartup,
          agentBySession,
          agentHistory
        };
      }),
      
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
        showNoteButton: state.showNoteButton,
        noteChips: state.noteChips,
        pinnedNotes: state.pinnedNotes,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        paneWidths: state.paneWidths,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelTabs: state.rightPanelTabs,
        rightPanelWidth: state.rightPanelWidth,
        editorPanelWidth: state.editorPanelWidth,
        hiddenHeaderButtons: state.hiddenHeaderButtons,
        mobileLowPower: state.mobileLowPower,
        mobileMode: state.mobileMode,
        mobilePanelWidth: state.mobilePanelWidth,
        mobileFloatRect: state.mobileFloatRect,
        artifactsBySession: state.artifactsBySession
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
          pendingWrite.name = name;
          pendingWrite.value = value;
          if (writeTimer) return; // trailing edge already scheduled — it picks up the latest value
          writeTimer = setTimeout(flushWrite, PERSIST_DEBOUNCE_MS);
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          // A queued write for this key would resurrect what was just removed
          if (pendingWrite.name === name) { pendingWrite.name = null; pendingWrite.value = null; }
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
