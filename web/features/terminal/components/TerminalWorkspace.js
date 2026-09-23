"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { busForSession, fleetBusOf, useFleetStore } from "@/shared/stores/fleetStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { PANE_WIDTH, PANE_GAP_PX, PANE_ROW_PADDING_PX, BG_LIST_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";
import { derivePaneLayout, mountDelayFor, sessionWorkspaceId, autoFitPaneWidth, UNGROUPED_KEY } from "@/features/terminal/lib/paneLayout";
import { startWidthDrag } from "@/shared/utils/dragResize";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import { dotClassName, statusVisual } from "@/shared/utils/statusVisual";
import { withHint } from "@/features/terminal/constants/shortcuts";
import { useInputMode } from "@/shared/hooks/useInputMode";
import TerminalHeader from "@/features/terminal/components/TerminalHeader";
import TerminalPane from "@/features/terminal/components/TerminalPane";
import TerminalSidebar from "@/features/terminal/components/TerminalSidebar";
import TerminalStatusBar, { MobileStatusStrip } from "@/features/terminal/components/TerminalStatusBar";
import MobileDock from "@/features/mobile/components/MobileDock";
import TerminalRightPanel from "@/features/terminal/components/TerminalRightPanel";
import TerminalEditorPanel from "@/features/terminal/components/TerminalEditorPanel";
import OverflowTip from "@/shared/components/ui/OverflowTip";
import TerminalBeam from "@/shared/components/ui/TerminalBeam";
import TerminalEmptyState from "@/features/terminal/components/TerminalEmptyState";
import AiPaneView from "@/features/ai/components/AiPaneView";
import { AI_UI_OPTIONS } from "@/features/ai/constants";
import ErrorBoundary from "@/shared/components/ui/ErrorBoundary";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { vibrate } from "@/shared/utils/vibration";

// Per-pane wrapper positioning terminal directly above the bottom input bar
const PaneContentWrapper = memo(function PaneContentWrapper({ children }) {
  return (
    <div className="absolute inset-x-0 top-0 bottom-[37px] overflow-hidden">
      {children}
    </div>
  );
});

// Isolated per-pane bottom status bar: shows constant-speed light sweep when working, static when done/blocked, hides when idle
const PaneStatusBar = memo(function PaneStatusBar({ sessionId }) {
  const sessionStatus = useNotificationStore((s) => sessionId ? s.sessionStatus[sessionId] : null);
  const state = sessionStatus?.state || "idle";

  if (state === "idle") return null;

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 h-[1px] pointer-events-none hidden sm:block">
      {state === "working" ? (
        <TerminalBeam />
      ) : state === "done" ? (
        <div
          className="w-full h-full bg-[#f59e0b]"
          style={{ boxShadow: "0 0 4px rgba(245,158,11,0.6)" }}
        />
      ) : state === "blocked" ? (
        <div
          className="w-full h-full bg-[#ef4444] animate-pulse"
          style={{ boxShadow: "0 0 4px rgba(239,68,68,0.7)" }}
        />
      ) : null}
    </div>
  );
});

// Unfocused pane's ghost row: shows the draft typed in that pane's input (collapsed
// to one line) so a half-written command stays visible after switching panes.
const InputDraftGhost = memo(function InputDraftGhost({ sessionId, placeholder }) {
  const draft = useTerminalStore((s) => s.drafts[sessionId] ?? "");
  const text = draft.replace(/\s+/g, " ").trim();
  if (!text) return <>{placeholder}</>;
  return <span className="text-text">{text}</span>;
});

// Terminal view shell: sidebar + header + multi-pane row + editor/tree panels + status bar.
function TerminalWorkspace({
  bus, busRef, connected, carrier, platform, agentVersion,
  sessions, workspaces, activeSessionId, activeSession, activeWorkspaceId,
  openedSessions, livePanes, mountedWorkspaces, cwdBySession,
  sessionStatus, notifications,
  isDesktop, isTerminalView, slideClass, shells,
  sidebarCollapsed, sidebarWidth, setSidebarWidth, toggleSidebar,
  paneWidth = null, setPaneWidth,
  paneRegistry, bindSwipeTab, nav,
  onBack, onOpenRemote, onOpenMobile, onOpenFiles, onLogout, onStopCodespace, onUpdate, onRestart,
  onRenameHost, onDeleteHost,
  onDeleteWorkspace, onRenameWorkspace, onReorderSession, onSetHiddenRepos, atStackBottom = false,
  onAddWorkspace, onOpenSettings, homeDir, recentWorkspaces,
  rightPanel, editorPanel, mobilePanel, onOpenArtifact, fileBus,
  onCreateAnyHost, onQuickCreateHostAware,
  codespaceInfo, tunnelUrl, apiKey, connectionMode,
  subscribeToPush, unsubscribeFromPush, updateAvailable, canSelfUpdate
}) {
  const { t } = useI18n();
  const hasKeyboard = useInputMode() === "mouse";
  const storeBus = useConnectionStore((s) => s.bus);
  const storeBusRef = useConnectionStore((s) => s.busRef);
  const storeConnected = useConnectionStore((s) => s.connected);
  const storeCarrier = useConnectionStore((s) => s.carrier);
  const activeBus = bus || storeBus;
  const activeBusRef = busRef || storeBusRef;
  // The workspace model runs on the merged list (foreign ids scoped "head:"); the
  // sidebar keeps the main host's own tree and draws the other hosts itself.
  const mainSessions = useMemo(() => sessions.filter((s) => !s.hostKey), [sessions]);
  const mainWorkspaces = useMemo(() => workspaces.filter((w) => !w.hostKey), [workspaces]);
  // A pane's bus follows its session's host: foreign sessions ride their fleet bus,
  // main-host ones the workspace singleton.
  const busFor = useCallback((sessionId) => {
    const fb = busForSession(sessionId);
    if (fb) return fb;
    // Main sessions ride the workspace bus; another host's cached session with
    // no bus yet waits (null) — never join it on the wrong machine. The bus
    // opening flips host status, re-renders, and the pane comes alive.
    return sessions.find((s) => s.id === sessionId)?.hostKey ? null : activeBus;
  }, [activeBus, sessions]);
  const isConnected = connected ?? storeConnected;
  const activeCarrier = carrier || storeCarrier;
  const activeFileBus = fileBus || useFileBusStore.getState();

  const {
    panesContainerRef, registerPaneApi, registerPaneElement, registerKeyboardTextApi,
    handlePasteFallback, handleInputFocusChange, focusPane, focusKeyboardInput, scrollPaneIntoView
  } = paneRegistry;

  // The pinned mirror renders into this column via a portal, so the node is
  // published to MobileDock rather than looked up by id.
  const [mobilePinSlot, setMobilePinSlot] = useState(null);

  // Builds three Sets and two Maps — recomputing it on every unrelated render (status tick,
  // cwd update) also hands every consumer fresh collection identities.
  const { workspaceSessionIds, workspaceOpenedSessions, renderedSessions, mountedSet, workspaceIndex } = useMemo(
    () => derivePaneLayout({ sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop }),
    [sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop]
  );

  // Stable identity: the header scrolls the active tab into view whenever this
  // array changes, so a fresh one per render would re-scroll the tab strip.
  const workspaceSessions = useMemo(
    () => sessions.filter((s) => sessionWorkspaceId(s) === activeWorkspaceId),
    [sessions, activeWorkspaceId]
  );

  // Background pool position follows the header tab order, not openedSessions —
  // those are open order, which drifts from what the user sees in the strip.
  const tabIndexBySession = useMemo(
    () => new Map(workspaceSessions.map((s, i) => [s.id, i])),
    [workspaceSessions]
  );

  // Root the side panels track: the active workspace's own path, else the fixed
  // workspacePath of the focused terminal (a workspace migrated from a group has no path).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const baseRoot = activeWorkspace?.path || activeSession?.workspacePath || null;
  // A pane's folder button reveals its live cwd into the files tab only — git/worktrees
  // tabs keep the workspace root, so a deep cwd must not blank their repo scan.
  const rightPanelRoots = useTerminalStore((s) => s.rightPanelRoots);
  const agentBySession = useTerminalStore((s) => s.agentBySession);
  const fullModes = useTerminalStore((s) => s.fullModes || {});
  const fullMode = fullModes[activeWorkspaceId ?? UNGROUPED_KEY] ?? false;
  const hiddenPaneSessionIds = useTerminalStore((s) => s.hiddenPaneSessionIds || []);
  const setRightPanelRoot = useTerminalStore((s) => s.setRightPanelRoot);
  const openRightPanel = useTerminalStore((s) => s.openRightPanel);
  const reorderOpenedSessions = useTerminalStore((s) => s.reorderOpenedSessions);
  // One drag moves all three views of the same list: sidebar/tabs (server order) and the
  // panes on screen (local open order).
  const handleReorderSession = useCallback((orderedIds) => {
    reorderOpenedSessions(orderedIds);
    onReorderSession?.(orderedIds);
  }, [reorderOpenedSessions, onReorderSession]);
  const handleSelectTab = useCallback((sessionId) => {
    nav.handleSelectSession(sessionId);
  }, [nav]);
  // Agent history is queried over the MAIN bus with the active cwd — for another
  // host's session that asks the wrong machine. Hide it there until the panel
  // takes a per-host bus.
  const activeSessionForeign = !!sessions.find((s) => s.id === activeSessionId)?.hostKey;
  // The header's "+" creates on whichever host owns the active workspace — the
  // host-aware doors come from layout (one implementation for every entry point)
  // — and its modal reads THAT host's agent list and shells.
  const activeWsHostKey = activeWorkspace?.hostKey || null;
  const headerModalBusRef = useMemo(
    () => (activeWsHostKey ? { current: fleetBusOf(activeWsHostKey) } : activeBusRef),
    [activeWsHostKey, activeBusRef]
  );
  const [foreignShells, setForeignShells] = useState([]);
  const activeHostStatus = useFleetStore((s) => (activeWsHostKey ? s.hosts[activeWsHostKey]?.status || null : null));
  useEffect(() => {
    if (!activeWsHostKey) return;
    fleetBusOf(activeWsHostKey)?.emit("getShells", (res) => setForeignShells(res?.shells || []));
  }, [activeWsHostKey, activeHostStatus]);
  // The chat pane's "+" opens a fresh chat of the same engine and closes the one it
  // replaced — the tab strip must not grow an entry per chat.
  const handleNewChat = useCallback((aiUi, sessionId) => {
    // The replaced terminal is still in the list, and it is leaving — counting it would
    // step the number up on every press.
    const index = sessions.filter((s) =>
      s.id !== sessionId && sessionWorkspaceId(s) === (activeWorkspaceId ?? null)
    ).length + 1;
    nav.handleReplaceSession(sessionId, `${aiUi.short || aiUi.label} ${index}`, aiUi, true);
  }, [nav, sessions, activeWorkspaceId]);
  const filesRoot = rightPanelRoots[baseRoot] || baseRoot;
  // The right panel is memoized — these four would hand it a fresh closure per render.
  const handleRightPanelTabChange = useCallback(
    (tab) => rightPanel?.onTabChange(tab, baseRoot ?? ""),
    [rightPanel, baseRoot]
  );
  const handleOpenFilesRoot = useCallback(() => onOpenFiles?.(filesRoot), [onOpenFiles, filesRoot]);
  const workspaceHiddenRepos = useMemo(
    () => activeWorkspace?.hiddenRepos || [],
    [activeWorkspace?.hiddenRepos]
  );
  const handleHiddenReposChange = useCallback(
    (paths) => { if (activeWorkspace) onSetHiddenRepos?.(activeWorkspace.id, paths); },
    [activeWorkspace, onSetHiddenRepos]
  );
  // Where the focused terminal actually stands — the panel opens the worktree holding it.
  // Chat UI panes emit no terminal OSC 7 — their dir comes from the session record.
  const activeCwd = activeSessionId
    ? cwdBySession[activeSessionId] || sessions.find((s) => s.id === activeSessionId)?.cwd || null
    : null;
  // Switching terminals drops a manual reveal: that pin belongs to the pane it was taken
  // from, and keeping it would strand the tree on another terminal's worktree.
  useEffect(() => {
    setRightPanelRoot(baseRoot, null);
  }, [activeSessionId, baseRoot, setRightPanelRoot]);
  const showEmptyState = !sessions.length;

  // The collapsed panel stays mounted so its width can animate, but only after a first
  // open — otherwise a user who never opens it still pays for the tree and git scan.
  const [everOpen, setEverOpen] = useState(false);
  if (rightPanel?.open && !everOpen) setEverOpen(true);
  // On that very first open the panel mounts already open, so there is no width change to
  // transition. Hold it at 0 for one painted frame, then let the width land.
  const [expanded, setExpanded] = useState(false);
  if (!rightPanel?.open && expanded) setExpanded(false);
  useEffect(() => {
    if (!rightPanel?.open) return;
    const id = requestAnimationFrame(() => setExpanded(true));
    return () => cancelAnimationFrame(id);
  }, [rightPanel?.open]);

  // Same two-step for the editor/artifact panel: stay mounted after a first open so its
  // width animates shut, and hold at 0 for one frame on that first open so it animates in.
  const editorOpen = !!editorPanel?.filePath;
  const [everOpenedEditor, setEverOpenedEditor] = useState(false);
  if (editorOpen && !everOpenedEditor) setEverOpenedEditor(true);
  const [editorExpanded, setEditorExpanded] = useState(false);
  if (!editorOpen && editorExpanded) setEditorExpanded(false);
  // Keep the last file on screen while the panel shrinks — unmounting it on close would
  // blank the panel first and then animate an empty box away.
  const [lastEditor, setLastEditor] = useState(null);
  if (editorOpen && lastEditor?.filePath !== editorPanel.filePath) {
    setLastEditor({
      filePath: editorPanel.filePath,
      artifactTitle: editorPanel.artifactTitle,
      previewSeq: editorPanel.previewSeq
    });
  }
  useEffect(() => {
    if (!editorOpen) return;
    const id = requestAnimationFrame(() => setEditorExpanded(true));
    return () => cancelAnimationFrame(id);
  }, [editorOpen]);

  // Auto pane width: split the row evenly down to min. Measured so width is always an
  // explicit px value — that keeps add/remove/double-click animatable via transition.
  // Measured on the OUTER row (sidebar + panes + panels), with every open side panel and
  // the sidebar's full width deducted, so the panes fit what is actually left of the row.
  // The row width itself never changes when a panel toggles (flex takes it out of the
  // panes' flex-1 column, not out of the row), so the panel widths are read here instead.
  const [rowWidth, setRowWidth] = useState(0);
  const [isPaneResizing, setIsPaneResizing] = useState(false);
  const rowRef = useRef(null);
  useEffect(() => {
    if (!isDesktop) return;
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setRowWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  // Pull the agent-saved custom backgrounds once per connection — the agent is the
  // source of truth, so a fresh device gets the same wallpapers as everyone else.
  // bg:list is new; older agents only answer bg:get (single legacy image).
  useEffect(() => {
    if (!isConnected || !activeBus?.emit) return;
    let cancelled = false;
    // An old agent has no bg:list handler, so its ack never fires — fall back to
    // the legacy single-image bg:get on timeout, not just on a failed ack.
    const legacyFetch = () => activeBus.emit("bg:get", {}, (res) => {
      if (!cancelled && res?.success && res.dataUrl) {
        useTerminalStore.getState().setCustomBackgrounds([{ id: "custom", dataUrl: res.dataUrl }]);
      }
    });
    const timer = setTimeout(() => { if (!cancelled) legacyFetch(); }, BG_LIST_TIMEOUT_MS);
    activeBus.emit("bg:list", {}, (res) => {
      if (cancelled) return;
      clearTimeout(timer);
      if (res?.success && Array.isArray(res.items)) useTerminalStore.getState().setCustomBackgrounds(res.items);
      else legacyFetch();
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [isConnected, activeBus]);

  const visibleWorkspaceSessions = useMemo(
    () => workspaceOpenedSessions.filter((id) => !hiddenPaneSessionIds.includes(id)),
    [workspaceOpenedSessions, hiddenPaneSessionIds]
  );
  const paneCount = visibleWorkspaceSessions.length;
  const appliedWidth = useTerminalStore((s) => s.autoPaneWidths[activeWorkspaceId] ?? null);
  const setAutoPaneWidth = useTerminalStore((s) => s.setAutoPaneWidth);
  // The side panels' own widths, not the row's: the row spans sidebar + panes + panels and
  // does not change when one toggles, so the deduction has to come from here.
  const sideWidth = (rightPanel?.open && expanded ? rightPanel.width : 0)
    + (editorOpen && editorExpanded ? editorPanel.width : 0)
    + (mobilePanel?.open && mobilePanel.mode === "pin" ? mobilePanel.width : 0);
  const autoWidth = autoFitPaneWidth({
    // A collapsed sidebar renders at 0 inside the row (rowWidth never changes), so the
    // deduction must follow its live width or the fit reserves space for a hidden panel.
    rowWidth, paneCount, sidebarWidth: sidebarCollapsed ? 0 : sidebarWidth, sidePx: sideWidth,
    gapPx: PANE_GAP_PX, paddingPx: PANE_ROW_PADDING_PX, minWidth: PANE_WIDTH.min,
    applied: appliedWidth
  });

  useEffect(() => {
    if (autoWidth != null) setAutoPaneWidth(activeWorkspaceId, autoWidth);
  }, [autoWidth, activeWorkspaceId, setAutoPaneWidth]);

  // Only a deliberate action widens the row back out: a viewport resize, a double-click,
  // adding or removing a pane, dragging the sidebar. A side panel toggling only narrows —
  // widening re-fits the PTY, and cols is one-way, so it would re-wrap scrollback nobody
  // asked to re-wrap. `autoPaneWidths` is the memory this compares against.
  const deliberateRef = useRef({ paneWidth, paneCount, sidebarWidth, rowWidth });
  useEffect(() => {
    const prev = deliberateRef.current;
    deliberateRef.current = { paneWidth, paneCount, sidebarWidth, rowWidth };
    if (prev.paneWidth === paneWidth && prev.paneCount === paneCount
      && prev.sidebarWidth === sidebarWidth && prev.rowWidth === rowWidth) return;
    setAutoPaneWidth(activeWorkspaceId, null);
  }, [paneWidth, paneCount, sidebarWidth, rowWidth, activeWorkspaceId, setAutoPaneWidth]);

  const effectivePaneWidth = paneWidth ?? autoWidth;

  // A side panel narrows the panes to fit, but a pinned (non-auto) row keeps its width and
  // scrolls instead — its scrollLeft doesn't follow, so the focused pane can slide out of
  // sight. Re-center it after the panel's 200ms width transition settles. (Session switches
  // are centered by the registry's own effect; this one only tracks panel changes.)
  const prevPanelStateRef = useRef({ editorFile: editorPanel?.filePath, rightOpen: rightPanel?.open });
  useEffect(() => {
    if (!isDesktop || !activeSessionId) return;
    const prev = prevPanelStateRef.current;
    const panelChanged = prev.editorFile !== editorPanel?.filePath || prev.rightOpen !== rightPanel?.open;
    prevPanelStateRef.current = { editorFile: editorPanel?.filePath, rightOpen: rightPanel?.open };
    if (!panelChanged) return;
    const id = setTimeout(() => {
      scrollPaneIntoView(activeSessionId);
    }, 260);
    return () => clearTimeout(id);
  }, [editorPanel?.filePath, rightPanel?.open, activeSessionId, isDesktop, scrollPaneIntoView]);

  useEffect(() => {
    if (isDesktop && fullMode && panesContainerRef.current) {
      panesContainerRef.current.scrollLeft = 0;
    }
  }, [isDesktop, fullMode, panesContainerRef]);

  // One width shared by every pane: dragging any splitter resizes the whole row at once,
  // so the panes stay a uniform grid instead of drifting into ragged columns.
  const startPaneResize = (e) => {
    // Dragging out of auto mode pins the row at the pane's current rendered width first.
    const startWidth = effectivePaneWidth ?? e.currentTarget.parentElement?.offsetWidth ?? PANE_WIDTH.min;
    setIsPaneResizing(true);
    startWidthDrag(e, {
      startWidth,
      onWidth: (w) => setPaneWidth?.(w),
      onEnd: () => setIsPaneResizing(false)
    });
  };

  // Double-click or shortcut: an explicit fit, so it re-fits both ways — including when the
  // row is already in auto mode but a side panel had narrowed it, which `paneWidth` alone
  // cannot signal (it is null in both cases).
  const fitPaneWidth = useCallback(() => {
    setAutoPaneWidth(activeWorkspaceId, null);
    setPaneWidth?.(null);
  }, [activeWorkspaceId, setAutoPaneWidth, setPaneWidth]);

  const [splitterMenu, setSplitterMenu] = useState(null);
  const splitterMenuRef = useRef(null);
  const splitterMenuPos = useClampedMenu(splitterMenuRef, splitterMenu?.x ?? 0, splitterMenu?.y ?? 0);

  const handleSplitterContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setSplitterMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const applySplitPreset = useCallback((fraction) => {
    if (fraction === "auto") {
      fitPaneWidth();
    } else {
      const containerWidth = panesContainerRef.current?.clientWidth
        || (rowWidth - (sidebarCollapsed ? 0 : sidebarWidth) - sideWidth);
      if (containerWidth > 0) {
        const targetWidth = Math.max(
          PANE_WIDTH.min,
          Math.floor((containerWidth - (fraction - 1) * PANE_GAP_PX) / fraction)
        );
        setAutoPaneWidth(activeWorkspaceId, null);
        setPaneWidth?.(targetWidth);
      }
    }
    setSplitterMenu(null);
  }, [fitPaneWidth, panesContainerRef, rowWidth, sidebarCollapsed, sidebarWidth, sideWidth, activeWorkspaceId, setAutoPaneWidth, setPaneWidth]);

  useEffect(() => {
    if (!splitterMenu) return;
    const onDoc = (e) => {
      if (splitterMenuRef.current && !splitterMenuRef.current.contains(e.target)) {
        setSplitterMenu(null);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") setSplitterMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [splitterMenu]);

  useEffect(() => {
    const onFit = () => fitPaneWidth();
    window.addEventListener("terminal:fitPanes", onFit);
    return () => window.removeEventListener("terminal:fitPanes", onFit);
  }, [fitPaneWidth]);

  useEffect(() => {
    const onPreset = (e) => {
      if (e.detail?.fraction) applySplitPreset(e.detail.fraction);
    };
    window.addEventListener("terminal:splitPreset", onPreset);
    return () => window.removeEventListener("terminal:splitPreset", onPreset);
  }, [applySplitPreset]);

  const renderPane = (sessionId, isVisible, isFocused, bgIndex = 0) => {
    const session = sessions.find((s) => s.id === sessionId);
    const sessionAgent = agentBySession[sessionId];
    // Resolved from the engine registry, not a hardcoded id list: adding an engine
    // must not need a second edit here (antigravity-ui rendered as a terminal).
    const aiUi = AI_UI_OPTIONS.find((u) => u.id === sessionAgent);
    if (aiUi) {
      return (
        <ErrorBoundary key={sessionId} title="AI Chat Pane">
          <AiPaneView
            sessionId={sessionId}
            engine={aiUi.aiEngine}
            workspacePath={session?.cwd || session?.workspacePath || activeWorkspace?.path}
            sessionName={session?.name}
            bus={activeBus}
            fileBus={activeFileBus}
            isVisible={isVisible}
            isFocused={isFocused}
            isDesktop={isDesktop}
            bgIndex={bgIndex}
            onActivate={() => nav.handleSelectSession(sessionId)}
            onNewChat={() => handleNewChat(aiUi, sessionId)}
            onOpenRemote={onOpenRemote}
            onOpenMobile={onOpenMobile}
            onOpenArtifact={onOpenArtifact}
          />
        </ErrorBoundary>
      );
    }
    return (
    <TerminalPane
      // Session's own workspace — the folder button opens the right panel's files tab
      // keyed to it, not to whichever workspace currently owns the panel.
      workspacePath={session?.workspacePath}
      sessionName={session?.name}
      bus={busFor(sessionId)}
      connected={isConnected}
      sessionId={sessionId}
      isVisible={isVisible}
      isFocused={isFocused}
      onActivate={nav.handleSelectSession}
      onRegisterApi={registerPaneApi}
      onPasteFallback={handlePasteFallback}
      showFocusBorder={false}
      mountDelay={mountDelayFor(sessionId, isFocused, workspaceIndex)}
      bgIndex={bgIndex}
      onOpenArtifact={onOpenArtifact}
      onOpenRemote={onOpenRemote}
      onOpenMobile={onOpenMobile}
    />
    );
  };

  const renderKeyboard = (sessionId) => (
    <MobileKeyboard
      bus={busFor(sessionId)}
      sessionId={sessionId}
      onExpandChange={() => {}}
      onRefocus={() => focusPane(sessionId)}
      onRegisterTextApi={registerKeyboardTextApi}
      onInputFocusChange={handleInputFocusChange}
      platform={platform}
      // Typing is what marks a finished session read. Passed as the store's own method (a
      // stable reference — MobileKeyboard is memoized) and called with its own sessionId.
      onInput={useNotificationStore.getState().clearNotification}
      onSwitchSession={nav.switchSession}
      onSwitchToIndex={nav.switchToIndex}
      isDesktop={isDesktop}
      statusStrip={(
        <MobileStatusStrip
          sessionId={sessionId}
          busRef={activeBusRef}
          onReveal={(cwd) => {
            const wsPath = sessions.find((s) => s.id === sessionId)?.workspacePath;
            setRightPanelRoot(wsPath, cwd || wsPath);
            // Mobile-only strip: open on the workspace's saved tab, not forced to files
            openRightPanel();
          }}
        />
      )}
    />
  );

  return (
    <div
      className={`absolute inset-0 flex flex-col ${isTerminalView ? "translate-x-0 opacity-100 z-10" : "translate-x-full opacity-0 z-0 pointer-events-none"}`}
    >
      <div ref={rowRef} className={`flex-1 min-h-0 relative ${isDesktop ? "flex flex-row" : "flex flex-col"}`}>
        {isDesktop && (
          <div
            className="hidden sm:block overflow-hidden flex-shrink-0 transition-[width] duration-200 ease-out"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <TerminalSidebar
              allSessions={mainSessions}
              workspaces={mainWorkspaces}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorkspaceId}
              onSelectSession={nav.handleSelectSession}
              onSelectWorkspace={nav.handleSelectWorkspace}
              onCreateNamedSession={nav.handleCreateSession}
              onResumeAgentSession={activeSessionForeign ? null : nav.handleResumeAgentSession}
              shells={shells}
              onRenameSession={nav.handleRenameSession}
              onDeleteSession={nav.handleDeleteSession}
              onReorderSession={handleReorderSession}
              onDeleteWorkspace={onDeleteWorkspace}
              onAddWorkspace={onAddWorkspace}
              onRenameWorkspace={onRenameWorkspace}
              onOpenSettings={onOpenSettings}
              onLogout={onLogout}
              onRenameHost={onRenameHost}
              onDeleteHost={onDeleteHost}
              busRef={activeBusRef}
              homeDir={homeDir}
              cwdBySession={cwdBySession}
              connected={isConnected}
              width={sidebarWidth}
              onResize={setSidebarWidth}
              onCollapse={toggleSidebar}
            />
          </div>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {/* With no session there is nothing to tab between, so the strip goes away on
              desktop. Mobile keeps it: the header is the only way to reach Settings there,
              since the sidebar (which holds it on desktop) does not exist. */}
          {(!showEmptyState || !isDesktop) && (
          <TerminalHeader
            sessions={workspaceSessions}
            allSessions={sessions}
            activeSessionId={activeSessionId}
            isActive={isTerminalView}
            connected={isConnected}
            onSwitchSession={handleSelectTab}
            onCreateSession={activeWsHostKey ? onQuickCreateHostAware : nav.handleQuickCreateSession}
            onRenameSession={nav.handleRenameSession}
            onDeleteSession={nav.handleDeleteSession}
            onCreateNamedSession={onCreateAnyHost}
            modalBusRef={headerModalBusRef}
            modalHostKey={activeWsHostKey || "main"}
            modalShells={activeWsHostKey ? foreignShells : null}
            onResumeAgentSession={activeSessionForeign ? null : nav.handleResumeAgentSession}
            onBack={!isDesktop && !atStackBottom ? onBack : null}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={nav.handleSelectWorkspace}
            hasUngrouped={sessions.some(s => !sessionWorkspaceId(s))}
            onOpenRemote={onOpenRemote}
            onOpenMobile={onOpenMobile}
            onOpenFiles={onOpenFiles}
            onLogout={onLogout}
            onStopCodespace={onStopCodespace}
            onUpdate={onUpdate}
            onRestart={onRestart}
            codespaceInfo={codespaceInfo}
            tunnelUrl={tunnelUrl}
            apiKey={apiKey}
            connectionMode={connectionMode}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            agentVersion={agentVersion}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
            busRef={activeBusRef}
            carrier={activeCarrier}
            shells={shells}
            onToggleSidebar={isDesktop ? toggleSidebar : null}
            sidebarCollapsed={sidebarCollapsed}
            onReorderSession={handleReorderSession}
            onToggleRightPanel={rightPanel?.onToggle}
            rightPanelOpen={rightPanel?.open}
            fileBus={activeFileBus}
            homeDir={homeDir}
            isDesktop={isDesktop}
          />
          )}

          {/* Panes container: desktop = horizontal scroll split, mobile = overlay active pane */}
          {showEmptyState ? (
            <div className="flex-1 min-h-0">
              <TerminalEmptyState
                onAddWorkspace={onAddWorkspace}
                onOpenRemote={onOpenRemote}
                recent={recentWorkspaces}
                homeDir={homeDir}
                onOpenRecent={(path) => onAddWorkspace?.(path)}
              />
            </div>
          ) : (
          <div
            ref={panesContainerRef}
            className={`flex-1 min-h-0 ${isDesktop ? `flex flex-row ${fullMode ? "overflow-hidden" : "overflow-x-auto"} overflow-y-hidden px-0 pb-0 scrollbar-none` : "relative"}`}
            {...bindSwipeTab({
              enabled: !isDesktop,
              sessionIds: workspaceOpenedSessions,
              activeSessionId,
              onSwitch: nav.handleSelectSession
            })}
          >
            {renderedSessions.map((sessionId) => {
              const inActiveWorkspace = workspaceSessionIds.has(sessionId);
              const isFocused = sessionId === activeSessionId;
              const isHidden = hiddenPaneSessionIds.includes(sessionId);
              const isVisible = inActiveWorkspace && !isHidden && (isDesktop ? (!fullMode || isFocused) : isFocused);
              // Background pool position — matches the header tab order
              const bgIndex = tabIndexBySession.get(sessionId) ?? 0;
              // Panes outside the active workspace stay mounted (LRU) but fully hidden
              return (
                <div
                  key={sessionId}
                  ref={(el) => registerPaneElement(sessionId, el)}
                  className={
                    !inActiveWorkspace || (isDesktop && fullMode && !isFocused) || (isDesktop && isHidden)
                      ? "hidden"
                      : isDesktop
                      ? `h-full relative bg-bg ${fullMode ? "w-full flex-1" : `border-r-2 border-border-subtle last:border-r-0 ${isPaneResizing ? "" : "transition-[width] duration-200 ease-out"}`}`
                      : `absolute inset-0 ${isFocused ? `opacity-100 z-10 ${slideClass}` : "opacity-0 z-0 pointer-events-none"}`
                  }
                  // Explicit px width (pinned or computed auto) so every width change —
                  // drag, double-click back to auto, add/remove pane — animates. Before
                  // the container is first measured, fall back to flex so the first paint
                  // is already the right size instead of animating up from min.
                  style={inActiveWorkspace && isDesktop
                    ? (fullMode
                      ? { width: "100%", flex: "1 1 0" }
                      : (effectivePaneWidth != null
                        ? { width: effectivePaneWidth, flexShrink: 0 }
                        : { flex: "1 1 0", minWidth: PANE_WIDTH.min }))
                    : undefined}
                >
                  {!mountedSet.has(sessionId) ? (
                    // Placeholder — workspace not yet visited; mounts on first entry
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs" />
                  ) : agentBySession[sessionId]?.endsWith("-ui") ? (
                    <div
                      onMouseDown={() => { if (!isFocused) nav.handleSelectSession(sessionId); }}
                      onTouchStart={() => { if (!isFocused) nav.handleSelectSession(sessionId); }}
                      className="w-full h-full flex flex-col relative overflow-hidden"
                    >
                      {renderPane(sessionId, isVisible, isFocused, bgIndex)}
                    </div>
                  ) : isDesktop ? (
                    <>
                      <PaneContentWrapper>
                        {renderPane(sessionId, isVisible, isFocused, bgIndex)}
                        <PaneStatusBar sessionId={sessionId} />
                      </PaneContentWrapper>
                      {/* Per-pane input slot — absolute, directly below the terminal */}
                      <div className="absolute inset-x-0 bottom-0 z-20 border-t border-border-subtle bg-surface">
                        {isFocused ? renderKeyboard(sessionId) : (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => {
                              nav.handleSelectSession(sessionId);
                              setTimeout(focusKeyboardInput, 60);
                            }}
                            className="group block w-full text-left"
                            aria-label="Focus this terminal input"
                          >
                            <span className="block w-full pl-9 pr-16 py-2 text-sm text-text-muted/60 group-hover:bg-surface-2/70 group-hover:text-text-muted transition-colors truncate">
                              <InputDraftGhost sessionId={sessionId} placeholder={t("mobileKeyboard.typeCommand")} />
                            </span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : renderPane(sessionId, isVisible, isFocused, bgIndex)}

                  {/* Splitter — drags the one shared width; double-click returns to auto-fit. */}
                  {inActiveWorkspace && isDesktop && !fullMode && !isHidden && (
                    <div
                      onPointerDown={startPaneResize}
                      onDoubleClick={fitPaneWidth}
                      onContextMenu={handleSplitterContextMenu}
                      className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-30"
                      title={hasKeyboard ? withHint(t("shortcuts.fitPanes") || "Auto-fit panes", "fitPanes") : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
          )}

          {/* Mobile: one shared keyboard below the active pane (desktop renders its own per pane) */}
          {!isDesktop && activeSessionId && !agentBySession[activeSessionId]?.endsWith("-ui") && renderKeyboard(activeSessionId)}

        </div>

        {/* Inline editor, opened from the tree or by the AI (artifact). Desktop animates by
            width so the panes row reflows and the terminal is pushed aside, never covered;
            mobile takes the whole screen instead of a column. */}
        {(editorPanel?.filePath || (isDesktop && everOpenedEditor)) && (
          <div
            className={isDesktop
              ? "overflow-hidden flex-shrink-0 transition-[width] duration-200 ease-out"
              : "absolute inset-0 z-40 animate-in slide-in-from-bottom duration-200"}
            style={isDesktop ? { width: editorOpen && editorExpanded ? editorPanel.width : 0 } : undefined}
            aria-hidden={isDesktop && !editorOpen}
          >
            <TerminalEditorPanel
              filePath={editorOpen ? editorPanel.filePath : lastEditor?.filePath}
              artifactTitle={editorOpen ? editorPanel.artifactTitle : lastEditor?.artifactTitle}
              previewSeq={editorOpen ? editorPanel.previewSeq : lastEditor?.previewSeq}
              workspace={filesRoot}
              fileBus={activeFileBus}
              width={editorPanel.width}
              onResize={editorPanel.onResize}
              onClose={editorPanel.onClose}
              onOpenFull={editorPanel.onOpenFull}
              onOpenFile={editorPanel.onOpen}
              isDesktop={isDesktop}
            />
          </div>
        )}

        {/* Android mirror pinned right. Desktop only: on a phone the mirror takes
            the whole screen instead of splitting one. Floating and PiP modes are
            portalled out of this row by MobileDock itself. */}
        {/* Column the pinned mirror portals into. It is only the slot: MobileDock
            is mounted once, below, and moves its content between slots — two
            sibling branches would unmount it on every mode switch and tear the
            decoder down with it. */}
        {isDesktop && mobilePanel?.open && mobilePanel.mode === "pin" && (
          <div
            ref={setMobilePinSlot}
            className="relative overflow-hidden flex-shrink-0 border-l border-border"
            style={{ width: mobilePanel.width }}
          >
            <div
              onPointerDown={mobilePanel.onResizeStart}
              className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
            />
          </div>
        )}

        {/* Single mount for every mode — see the pin slot above. */}
        {isDesktop && mobilePanel?.open && (
          <MobileDock busRef={activeBusRef} protocolRef={mobilePanel.protocolRef} connected={isConnected} pinSlot={mobilePinSlot} />
        )}

        {/* Right panel: files / git / worktrees. Slides in over the panes on mobile, with a
            backdrop — otherwise there is no way to dismiss it by tapping away. */}
        {rightPanel?.open && !isDesktop && (
          <div
            className="absolute inset-0 z-20 bg-black/50 animate-in fade-in duration-200"
            onClick={rightPanel.onToggle}
          />
        )}
        {/* Desktop collapses by width instead of unmounting, so the panes reflow smoothly
            rather than snapping the moment the panel appears or goes away. */}
        {(rightPanel?.open || (isDesktop && everOpen)) && (
          <div
            className={isDesktop
              ? "overflow-hidden flex-shrink-0 transition-[width] duration-200 ease-out"
              : "absolute inset-y-0 right-0 z-30 w-[85%] max-w-sm shadow-elev animate-in slide-in-from-right duration-200"}
            style={isDesktop ? { width: rightPanel?.open && expanded ? rightPanel.width : 0 } : undefined}
            aria-hidden={isDesktop && !rightPanel?.open}
          >
            <TerminalRightPanel
              workspacePath={baseRoot}
              filesRoot={filesRoot}
              cwdHint={activeCwd}
              activeFile={editorPanel?.filePath}
              fileBus={activeFileBus}
              tab={rightPanel.tabs?.[baseRoot ?? ""] || "files"}
              onTabChange={handleRightPanelTabChange}
              width={rightPanel.width}
              onResize={rightPanel.onResize}
              onClose={rightPanel.onToggle}
              onOpenFiles={onOpenFiles ? handleOpenFilesRoot : null}
              onOpenFile={editorPanel?.onOpen}
              onNewTerminal={rightPanel.onNewTerminal}
              onAddWorkspace={onAddWorkspace}
              homeDir={homeDir}
              hiddenRepos={workspaceHiddenRepos}
              onHiddenReposChange={activeWorkspace && onSetHiddenRepos ? handleHiddenReposChange : null}
              isDesktop={isDesktop}
            />
          </div>
        )}
      </div>

      {/* Reveals the full text of any clipped label carrying data-tip */}
      <OverflowTip />

      {/* One status bar for the whole view, spanning sidebar + panes + side panels */}
      {isDesktop && !showEmptyState && (
        <TerminalStatusBar
          cwd={activeSessionId ? (cwdBySession[activeSessionId] || activeSession?.cwd || activeWorkspace?.path || "") : ""}
          sessionId={activeSessionId}
          busRef={activeBusRef}
          fileBus={activeFileBus}
          connected={isConnected}
          carrier={activeCarrier}
          sessionName={activeSession ? activeSession?.name : ""}
          agentVersion={agentVersion}
          platform={platform}
          homeDir={homeDir}
        />
      )}

      {/* Splitter context menu for layout presets */}
      {splitterMenu && (
        <div
          ref={splitterMenuRef}
          className="fixed z-[70] menu-popover p-1 min-w-[130px] animate-in fade-in zoom-in-95 duration-100 shadow-xl"
          style={{ left: splitterMenuPos.left, top: splitterMenuPos.top }}
        >
          <div className="px-2 py-1 text-[10px] font-semibold text-text-subtle uppercase tracking-wider">
            Split
          </div>
          <button
            type="button"
            onClick={() => { vibrate(); applySplitPreset("auto"); }}
            className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
          >
            <span>Auto Fit</span>
            <span className="text-[10px] text-text-muted">Auto</span>
          </button>
          <button
            type="button"
            onClick={() => { vibrate(); applySplitPreset(2); }}
            className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
          >
            <span>1/2</span>
            <span className="text-[10px] text-text-muted">50%</span>
          </button>
          <button
            type="button"
            onClick={() => { vibrate(); applySplitPreset(3); }}
            className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
          >
            <span>1/3</span>
            <span className="text-[10px] text-text-muted">33%</span>
          </button>
          <button
            type="button"
            onClick={() => { vibrate(); applySplitPreset(4); }}
            className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center justify-between"
          >
            <span>1/4</span>
            <span className="text-[10px] text-text-muted">25%</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Props are stabilized upstream (memoized panel descriptors, `nav`, store actions), so
// this only re-renders when something it actually shows changed.
export default memo(TerminalWorkspace);
