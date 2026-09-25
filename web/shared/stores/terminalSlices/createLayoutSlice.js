import {
  SIDEBAR_WIDTH, RIGHT_PANEL_WIDTH, EDITOR_PANEL_WIDTH, MOBILE_PANEL_WIDTH, PANE_WIDTH, DESKTOP_BREAKPOINT
} from "@/features/terminal/constants/terminalConfig";
import { UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";

const clampWidth = (w, { min, max }) => Math.max(min, Math.min(max, Math.round(w)));

const dropArtifact = (bySession, sessionId, filePath) => {
  const list = bySession[sessionId];
  if (!list) return bySession;
  const next = list.filter((a) => a.path !== filePath);
  if (next.length === list.length) return bySession;
  const { [sessionId]: _, ...rest } = bySession;
  return next.length ? { ...rest, [sessionId]: next } : rest;
};

export const createLayoutSlice = (set, get) => ({
  // Desktop sidebar collapse (terminal view). Persisted.
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: !!v }),

  // Desktop sidebar width (px). Persisted.
  sidebarWidth: SIDEBAR_WIDTH.default,
  setSidebarWidth: (w) => set({ sidebarWidth: clampWidth(w, SIDEBAR_WIDTH) }),

  // Desktop full / split mode per workspace (default: split)
  fullModes: {},
  fullMode: false,
  toggleFullMode: (wsId) => set((state) => {
    const id = wsId ?? state.activeWorkspaceId ?? UNGROUPED_KEY;
    const nextVal = !state.fullModes[id];
    return {
      fullModes: { ...state.fullModes, [id]: nextVal },
      fullMode: id === (state.activeWorkspaceId ?? UNGROUPED_KEY) ? nextVal : state.fullMode
    };
  }),
  setFullMode: (wsId, v) => set((state) => {
    const targetWsId = typeof wsId === "boolean" ? (state.activeWorkspaceId ?? UNGROUPED_KEY) : (wsId ?? state.activeWorkspaceId ?? UNGROUPED_KEY);
    const val = typeof wsId === "boolean" ? wsId : !!v;
    return {
      fullModes: { ...state.fullModes, [targetWsId]: val },
      fullMode: targetWsId === (state.activeWorkspaceId ?? UNGROUPED_KEY) ? val : state.fullMode
    };
  }),

  // Hidden pane session ids (desktop panel hide)
  hiddenPaneSessionIds: [],
  toggleHidePane: (sessionId) => set((state) => ({
    hiddenPaneSessionIds: state.hiddenPaneSessionIds.includes(sessionId)
      ? state.hiddenPaneSessionIds.filter((id) => id !== sessionId)
      : [...state.hiddenPaneSessionIds, sessionId]
  })),
  unhidePane: (sessionId) => set((state) => ({
    hiddenPaneSessionIds: state.hiddenPaneSessionIds.filter((id) => id !== sessionId)
  })),

  // Pane width per workspace (px). null/missing = auto
  paneWidths: {},
  setPaneWidth: (workspaceId, w) => set((state) => ({
    paneWidths: { ...state.paneWidths, [workspaceId]: w == null ? null : clampWidth(w, PANE_WIDTH) }
  })),

  // Right panel (file tree / git / worktrees). Open by default on desktop only
  rightPanelOpen: typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT,
  rightPanelTabs: {},
  rightPanelWidth: RIGHT_PANEL_WIDTH.default,
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen, rightPanelWasOpen: null })),
  closeRightPanel: () => set({ rightPanelOpen: false, rightPanelWasOpen: null }),
  openRightPanel: () => set({ rightPanelOpen: true, rightPanelWasOpen: null }),
  setRightPanelTab: (tab, workspacePath) => set((state) => ({
    rightPanelOpen: true,
    rightPanelWasOpen: null,
    ...(workspacePath != null ? { rightPanelTabs: { ...state.rightPanelTabs, [workspacePath]: tab } } : {})
  })),

  rightPanelRoots: {},
  setRightPanelRoot: (workspacePath, rootPath) => set((state) => {
    if (workspacePath == null) return state;
    const current = state.rightPanelRoots[workspacePath];
    const target = (!rootPath || rootPath === workspacePath) ? undefined : rootPath;
    if (current === target) return state;
    const next = { ...state.rightPanelRoots };
    if (!target) delete next[workspacePath];
    else next[workspacePath] = target;
    return { rightPanelRoots: next };
  }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: clampWidth(w, RIGHT_PANEL_WIDTH) }),

  // Inline editor
  editorFilePath: null,
  editorPanelWidth: EDITOR_PANEL_WIDTH.default,
  setEditorPanelWidth: (w) => set({ editorPanelWidth: clampWidth(w, EDITOR_PANEL_WIDTH) }),
  editorPreviewSeq: 0,
  artifactTitle: null,
  rightPanelWasOpen: null,
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

  // Header buttons
  hiddenHeaderButtons: ["mobile"],
  hiddenHeaderButtonsMigrated: false,
  toggleHeaderButton: (id) => set((state) => ({
    hiddenHeaderButtons: state.hiddenHeaderButtons.includes(id)
      ? state.hiddenHeaderButtons.filter((b) => b !== id)
      : [...state.hiddenHeaderButtons, id]
  })),

  // Mobile / AVD controls
  mobileLowPower: false,
  setMobileLowPower: (on) => set({ mobileLowPower: !!on }),
  mobileOpen: false,
  mobileMode: "float",
  mobilePanelWidth: MOBILE_PANEL_WIDTH.default,
  mobileFloatRect: null,
  setMobileOpen: (open) => set({ mobileOpen: !!open }),
  setMobileMode: (mode) => set({ mobileMode: mode, mobileOpen: true }),
  setMobilePanelWidth: (w) => set({ mobilePanelWidth: clampWidth(w, MOBILE_PANEL_WIDTH) }),
  setMobileFloatRect: (rect) => set({ mobileFloatRect: rect }),
  mobileSession: null,
  setMobileSession: (session) => set((state) => ({
    mobileSession: typeof session === "function" ? session(state.mobileSession) : session
  }))
});
