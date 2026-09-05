"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { PANE_WIDTH, PANE_GAP_PX, PANE_ROW_PADDING_PX, BG_LIST_TIMEOUT_MS } from "@/features/terminal/constants/terminalConfig";
import { derivePaneLayout, mountDelayFor, sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { startWidthDrag } from "@/shared/utils/dragResize";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";

const TerminalHeader = dynamic(() => import("@/features/terminal/components/TerminalHeader"), { ssr: false });
const TerminalPane = dynamic(() => import("@/features/terminal/components/TerminalPane"), { ssr: false });
const TerminalSidebar = dynamic(() => import("@/features/terminal/components/TerminalSidebar"), { ssr: false });
const TerminalStatusBar = dynamic(() => import("@/features/terminal/components/TerminalStatusBar"), { ssr: false });
const MobileDock = dynamic(() => import("@/features/mobile/components/MobileDock"), { ssr: false });
const MobileStatusStrip = dynamic(() => import("@/features/terminal/components/TerminalStatusBar").then((m) => m.MobileStatusStrip), { ssr: false });
const TerminalRightPanel = dynamic(() => import("@/features/terminal/components/TerminalRightPanel"), { ssr: false });
const TerminalEditorPanel = dynamic(() => import("@/features/terminal/components/TerminalEditorPanel"), { ssr: false });
const OverflowTip = dynamic(() => import("@/shared/components/ui/OverflowTip"), { ssr: false });
const TerminalEmptyState = dynamic(() => import("@/features/terminal/components/TerminalEmptyState"), { ssr: false });

const focusBorderClass = (isFocused, state) => {
  if (isFocused) return "outline outline-1 -outline-offset-1 outline-brand-500";
  if (state === "working") return "status-border-working";
  if (state === "blocked") return "status-border-blocked";
  if (state === "done") return "status-border-done";
  return "";
};

// Terminal view shell: sidebar + header + multi-pane row + editor/tree panels + status bar.
function TerminalWorkspace({
  bus, busRef, connected, carrier, platform, agentVersion,
  sessions, workspaces, activeSessionId, activeSession, activeWorkspaceId,
  openedSessions, livePanes, mountedWorkspaces, cwdBySession,
  sessionStatus, notifications, clearNotification,
  isDesktop, isTerminalView, slideClass, shells, fileBus,
  sidebarCollapsed, sidebarWidth, setSidebarWidth, toggleSidebar,
  paneWidth = null, setPaneWidth,
  paneRegistry, bindSwipeTab, nav,
  onBack, onOpenRemote, onOpenMobile, onOpenFiles, onLogout, onStopCodespace, onUpdate, onRestart,
  onDeleteWorkspace, onReorderSession, onSetHiddenRepos, atStackBottom = false,
  onAddWorkspace, onOpenSettings, homeDir, recentWorkspaces,
  rightPanel, editorPanel, mobilePanel, onOpenArtifact,
  codespaceInfo, tunnelUrl, apiKey, connectionMode,
  subscribeToPush, unsubscribeFromPush, updateAvailable, canSelfUpdate
}) {
  const { t } = useI18n();
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

  // Root the side panels track: the active workspace's own path, else the fixed
  // workspacePath of the focused terminal (a workspace migrated from a group has no path).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const baseRoot = activeWorkspace?.path || activeSession?.workspacePath || null;
  // A pane's folder button reveals its live cwd into the files tab only — git/worktrees
  // tabs keep the workspace root, so a deep cwd must not blank their repo scan.
  const rightPanelRoots = useTerminalStore((s) => s.rightPanelRoots);
  const setRightPanelRoot = useTerminalStore((s) => s.setRightPanelRoot);
  const openRightPanel = useTerminalStore((s) => s.openRightPanel);
  const reorderOpenedSessions = useTerminalStore((s) => s.reorderOpenedSessions);
  // One drag moves all three views of the same list: sidebar/tabs (server order) and the
  // panes on screen (local open order).
  const handleReorderSession = useCallback((orderedIds) => {
    reorderOpenedSessions(orderedIds);
    onReorderSession?.(orderedIds);
  }, [reorderOpenedSessions, onReorderSession]);
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
  const activeCwd = activeSessionId ? cwdBySession[activeSessionId] || null : null;
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
  // Measured on the OUTER row (sidebar + panes + panels) with the sidebar's full width always
  // deducted, open or collapsed: toggling any panel leaves pane width untouched — the row
  // scrolls instead of re-fitting the PTY (cols is one-way; a toggle must not re-wrap
  // scrollback). Dragging the sidebar splitter is deliberate, so that one does re-fit.
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
    if (!connected || !bus?.emit) return;
    let cancelled = false;
    // An old agent has no bg:list handler, so its ack never fires — fall back to
    // the legacy single-image bg:get on timeout, not just on a failed ack.
    const legacyFetch = () => bus.emit("bg:get", {}, (res) => {
      if (!cancelled && res?.success && res.dataUrl) {
        useTerminalStore.getState().setCustomBackgrounds([{ id: "custom", dataUrl: res.dataUrl }]);
      }
    });
    const timer = setTimeout(() => { if (!cancelled) legacyFetch(); }, BG_LIST_TIMEOUT_MS);
    bus.emit("bg:list", {}, (res) => {
      if (cancelled) return;
      clearTimeout(timer);
      if (res?.success && Array.isArray(res.items)) useTerminalStore.getState().setCustomBackgrounds(res.items);
      else legacyFetch();
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [connected, bus]);

  const paneCount = workspaceOpenedSessions.length;
  const autoBase = rowWidth - sidebarWidth - PANE_ROW_PADDING_PX;
  const autoWidth = rowWidth > 0 && paneCount > 0
    ? Math.max(PANE_WIDTH.min, Math.floor((autoBase - (paneCount - 1) * PANE_GAP_PX) / paneCount))
    : null;
  const effectivePaneWidth = paneWidth ?? autoWidth;

  // Opening/closing a side panel narrows the row while panes keep their width — the row's
  // scrollLeft doesn't follow, so the focused pane can slide out of sight. Re-center it
  // after the panel's 200ms width transition settles. (Session switches are centered by
  // the registry's own effect; this one only tracks layout-affecting panel changes.)
  useEffect(() => {
    if (!isDesktop || !activeSessionId) return;
    const id = setTimeout(() => scrollPaneIntoView(activeSessionId), 260);
    return () => clearTimeout(id);
  }, [editorPanel?.filePath, rightPanel?.open, activeSessionId, isDesktop, scrollPaneIntoView]);

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

  // Deliberate re-fit (double-click): unlike a panel toggle, this one measures the space
  // actually left between the sidebar and whatever side panels are currently open.
  const fitPaneWidth = () => {
    if (!rowWidth || !paneCount) return;
    const taken = (sidebarCollapsed ? 0 : sidebarWidth)
      + (rightPanel?.open ? rightPanel.width : 0)
      + (editorPanel?.filePath ? editorPanel.width : 0);
    const base = rowWidth - taken - PANE_ROW_PADDING_PX;
    setPaneWidth?.(Math.max(PANE_WIDTH.min, Math.floor((base - (paneCount - 1) * PANE_GAP_PX) / paneCount)));
  };

  const renderPane = (sessionId, isVisible, isFocused, bgIndex = 0) => {
    const session = sessions.find((s) => s.id === sessionId);
    return (
    <TerminalPane
      // Session's own workspace — the folder button opens the right panel's files tab
      // keyed to it, not to whichever workspace currently owns the panel.
      workspacePath={session?.workspacePath}
      sessionName={session?.name}
      sessionState={sessionStatus[sessionId]?.state || "idle"}
      bus={bus}
      connected={connected}
      sessionId={sessionId}
      isVisible={isVisible}
      isFocused={isFocused}
      onActivate={nav.handleSelectSession}
      onRegisterApi={registerPaneApi}
      onPasteFallback={handlePasteFallback}
      showFocusBorder={false}
      clearNotification={clearNotification}
      fileBus={fileBus}
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
      bus={bus}
      sessionId={sessionId}
      onExpandChange={() => {}}
      onRefocus={() => focusPane(sessionId)}
      onRegisterTextApi={registerKeyboardTextApi}
      onInputFocusChange={handleInputFocusChange}
      platform={platform}
      onInput={clearNotification}
      onSwitchSession={nav.switchSession}
      onSwitchToIndex={nav.switchToIndex}
      isDesktop={isDesktop}
      statusStrip={(
        <MobileStatusStrip
          sessionId={sessionId}
          fileBus={fileBus}
          busRef={busRef}
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
              allSessions={sessions}
              workspaces={workspaces}
              activeSessionId={activeSessionId}
              activeWorkspaceId={activeWorkspaceId}
              sessionStatus={sessionStatus}
              notifications={notifications}
              onSelectSession={nav.handleSelectSession}
              onSelectWorkspace={nav.handleSelectWorkspace}
              onCreateNamedSession={nav.handleCreateSession}
              onResumeAgentSession={nav.handleResumeAgentSession}
              shells={shells}
              onRenameSession={nav.handleRenameSession}
              onDeleteSession={nav.handleDeleteSession}
              onReorderSession={handleReorderSession}
              onDeleteWorkspace={onDeleteWorkspace}
              onAddWorkspace={onAddWorkspace}
              onOpenSettings={onOpenSettings}
              busRef={busRef}
              fileBus={fileBus}
              homeDir={homeDir}
              cwdBySession={cwdBySession}
              connected={connected}
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
            connected={connected}
            notifications={notifications}
            sessionStatus={sessionStatus}
            onSwitchSession={nav.handleSelectSession}
            onCreateSession={nav.handleQuickCreateSession}
            onRenameSession={nav.handleRenameSession}
            onDeleteSession={nav.handleDeleteSession}
            onCreateNamedSession={nav.handleCreateSession}
            onResumeAgentSession={nav.handleResumeAgentSession}
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
            busRef={busRef}
            carrier={carrier}
            shells={shells}
            onToggleSidebar={isDesktop ? toggleSidebar : null}
            sidebarCollapsed={sidebarCollapsed}
            onReorderSession={handleReorderSession}
            onToggleRightPanel={rightPanel?.onToggle}
            rightPanelOpen={rightPanel?.open}
            fileBus={fileBus}
            homeDir={homeDir}
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
            className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row gap-1 overflow-x-auto overflow-y-hidden px-1 pb-0 scrollbar-none" : "relative"}`}
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
              const isVisible = inActiveWorkspace && (isDesktop || isFocused);
              // Background pool position — panes round-robin by display order
              const bgIndex = workspaceIndex.get(sessionId) ?? 0;
              // Panes outside the active workspace stay mounted (LRU) but fully hidden
              return (
                <div
                  key={sessionId}
                  ref={(el) => registerPaneElement(sessionId, el)}
                  className={
                    !inActiveWorkspace
                      ? "hidden"
                      : isDesktop
                      ? `h-full relative ${isPaneResizing ? "" : "transition-[width] duration-200 ease-out"}`
                      : `absolute inset-0 ${isFocused ? `opacity-100 z-10 ${slideClass}` : "opacity-0 z-0 pointer-events-none"}`
                  }
                  // Explicit px width (pinned or computed auto) so every width change —
                  // drag, double-click back to auto, add/remove pane — animates. Before
                  // the container is first measured, fall back to flex so the first paint
                  // is already the right size instead of animating up from min.
                  style={inActiveWorkspace && isDesktop
                    ? (effectivePaneWidth != null
                      ? { width: effectivePaneWidth, flexShrink: 0 }
                      : { flex: "1 1 0", minWidth: PANE_WIDTH.min })
                    : undefined}
                >
                  {!mountedSet.has(sessionId) ? (
                    // Placeholder — workspace not yet visited; mounts on first entry
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs" />
                  ) : isDesktop ? (
                    <>
                      {/* Focus ring is redundant when the workspace has a single pane */}
                      <div className={`absolute inset-x-0 top-0 bottom-[37px] overflow-hidden p-px ${focusBorderClass(isFocused && workspaceOpenedSessions.length > 1, sessionStatus[sessionId]?.state || "idle")}`}>
                        {renderPane(sessionId, isVisible, isFocused, bgIndex)}
                      </div>
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
                            <span className="block w-full pl-9 pr-16 py-2 text-sm text-text-muted/60 group-hover:bg-surface-2/70 group-hover:text-text-muted transition-colors">
                              {t("mobileKeyboard.typeCommand")}
                            </span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : renderPane(sessionId, isVisible, isFocused, bgIndex)}

                  {/* Splitter — drags the one shared width; double-click returns to auto-fit. */}
                  {inActiveWorkspace && isDesktop && (
                    <div
                      onPointerDown={startPaneResize}
                      onDoubleClick={fitPaneWidth}
                      className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-30"
                    />
                  )}
                </div>
              );
            })}
          </div>
          )}

          {/* Mobile: one shared keyboard below the active pane (desktop renders its own per pane) */}
          {!isDesktop && activeSessionId && renderKeyboard(activeSessionId)}

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
              fileBus={fileBus}
              width={editorPanel.width}
              onResize={editorPanel.onResize}
              onClose={editorPanel.onClose}
              onOpenFull={editorPanel.onOpenFull}
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
          <MobileDock busRef={busRef} protocolRef={mobilePanel.protocolRef} connected={connected} pinSlot={mobilePinSlot} />
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
              fileBus={fileBus}
              activeFile={editorPanel?.filePath}
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
          cwd={activeSessionId ? cwdBySession[activeSessionId] || "" : ""}
          fileBus={fileBus}
          busRef={busRef}
          connected={connected}
          sessionState={activeSessionId ? sessionStatus[activeSessionId]?.state : "idle"}
          carrier={carrier}
          sessionName={activeSession ? activeSession?.name : ""}
          agentVersion={agentVersion}
          platform={platform}
        />
      )}
    </div>
  );
}

// Props are stabilized upstream (memoized panel descriptors, `nav`, store actions), so
// this only re-renders when something it actually shows changed.
export default memo(TerminalWorkspace);
