"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { PANE_WIDTH, PANE_GAP_PX, PANE_ROW_PADDING_PX } from "@/features/terminal/constants/terminalConfig";
import { derivePaneLayout, mountDelayFor, sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useWorkspaceChangedCount } from "@/features/terminal/hooks/useWorkspaceChangedCount";

const TerminalHeader = dynamic(() => import("@/features/terminal/components/TerminalHeader"), { ssr: false });
const TerminalPane = dynamic(() => import("@/features/terminal/components/TerminalPane"), { ssr: false });
const TerminalSidebar = dynamic(() => import("@/features/terminal/components/TerminalSidebar"), { ssr: false });
const TerminalStatusBar = dynamic(() => import("@/features/terminal/components/TerminalStatusBar"), { ssr: false });
const TerminalRightPanel = dynamic(() => import("@/features/terminal/components/TerminalRightPanel"), { ssr: false });
const TerminalEditorPanel = dynamic(() => import("@/features/terminal/components/TerminalEditorPanel"), { ssr: false });
const TerminalEmptyState = dynamic(() => import("@/features/terminal/components/TerminalEmptyState"), { ssr: false });

const focusBorderClass = (isFocused, state) => {
  if (isFocused) return "outline outline-1 -outline-offset-1 outline-brand-500";
  if (state === "working") return "status-border-working";
  if (state === "blocked") return "status-border-blocked";
  if (state === "done") return "status-border-done";
  return "";
};

// Terminal view shell: sidebar + header + multi-pane row + editor/tree panels + status bar.
export default function TerminalWorkspace({
  socket, socketRef, connected, transport, platform, agentVersion,
  sessions, workspaces, activeSessionId, activeSession, activeWorkspaceId,
  openedSessions, livePanes, mountedWorkspaces, cwdBySession,
  sessionStatus, notifications, clearNotification,
  isDesktop, isTerminalView, slideClass, shells, fileSocket,
  sidebarCollapsed, sidebarWidth, setSidebarWidth, toggleSidebar,
  paneWidth = null, setPaneWidth,
  paneRegistry, bindSwipeTab, nav,
  onBack, onOpenRemote, onOpenFiles, onLogout, onStopCodespace, onUpdate, onRestart,
  onDeleteWorkspace, onMoveSession, onReorderSession, onSetHiddenRepos, atStackBottom = false,
  onAddWorkspace, onOpenSettings, homeDir, recentWorkspaces,
  rightPanel, editorPanel,
  codespaceInfo, tunnelUrl, apiKey, connectionMode,
  subscribeToPush, unsubscribeFromPush, updateAvailable, canSelfUpdate
}) {
  const { t } = useI18n();
  const {
    panesContainerRef, registerPaneApi, registerPaneElement, registerKeyboardTextApi,
    handlePasteFallback, handleInputFocusChange, focusPane, focusKeyboardInput, scrollPaneIntoView
  } = paneRegistry;

  const { workspaceSessionIds, workspaceOpenedSessions, renderedSessions, mountedSet, workspaceIndex } =
    derivePaneLayout({ sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop });

  // Root the side panels track: the active workspace's own path, else the fixed
  // workspacePath of the focused terminal (a workspace migrated from a group has no path).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const panelRoot = activeWorkspace?.path || activeSession?.workspacePath || null;
  const showEmptyState = !sessions.length;

  // One count for the whole workspace, shared by the pane badge and the git tab so the
  // two can never show different numbers. Polled only while something displays it.
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const showGitButton = useTerminalStore((s) => s.showGitButton);
  const gitCountsEnabled = (showFolderButton && showGitButton) || !!rightPanel?.open;
  const gitCounts = useWorkspaceChangedCount(panelRoot, fileSocket, { enabled: gitCountsEnabled });

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
    e.preventDefault();
    const startX = e.clientX;
    // Dragging out of auto mode pins the row at the pane's current rendered width first.
    const startW = effectivePaneWidth ?? e.currentTarget.parentElement?.offsetWidth ?? PANE_WIDTH.min;
    const onMove = (ev) => setPaneWidth?.(startW + (ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsPaneResizing(false);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setIsPaneResizing(true);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
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

  const renderPane = (sessionId, isVisible, isFocused) => (
    <TerminalPane
      socket={socket}
      connected={connected}
      sessionId={sessionId}
      isVisible={isVisible}
      isFocused={isFocused}
      onActivate={nav.handleSelectSession}
      onRegisterApi={registerPaneApi}
      onPasteFallback={handlePasteFallback}
      showFocusBorder={false}
      notifications={notifications}
      sessionStatus={sessionStatus}
      clearNotification={clearNotification}
      fileSocket={fileSocket}
      changedCount={gitCounts.count}
      countFallback={!panelRoot && gitCountsEnabled}
      mountDelay={mountDelayFor(sessionId, isFocused, workspaceIndex)}
    />
  );

  const renderKeyboard = (sessionId) => (
    <MobileKeyboard
      socket={socket}
      sessionId={sessionId}
      onExpandChange={() => {}}
      onRefocus={() => focusPane(sessionId)}
      onRegisterTextApi={registerKeyboardTextApi}
      onInputFocusChange={handleInputFocusChange}
      platform={platform}
      onInput={clearNotification}
      onSwitchSession={nav.switchSession}
      onSwitchToIndex={nav.switchToIndex}
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
              shells={shells}
              onRenameSession={nav.handleRenameSession}
              onDeleteSession={nav.handleDeleteSession}
              onReorderSession={onReorderSession}
              onMoveSession={onMoveSession}
              onDeleteWorkspace={onDeleteWorkspace}
              onAddWorkspace={onAddWorkspace}
              onOpenSettings={onOpenSettings}
              fileSocket={fileSocket}
              homeDir={homeDir}
              cwdBySession={cwdBySession}
              connected={connected}
              width={sidebarWidth}
              onResize={setSidebarWidth}
              onCollapse={toggleSidebar}
            />
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col">
          {/* With no session there is nothing to tab between, so the strip goes away on
              desktop. Mobile keeps it: the header is the only way to reach Settings there,
              since the sidebar (which holds it on desktop) does not exist. */}
          {(!showEmptyState || !isDesktop) && (
          <TerminalHeader
            sessions={sessions.filter(s => sessionWorkspaceId(s) === activeWorkspaceId)}
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
            onBack={!isDesktop && !atStackBottom ? onBack : null}
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={nav.handleSelectWorkspace}
            hasUngrouped={sessions.some(s => !sessionWorkspaceId(s))}
            onOpenRemote={onOpenRemote}
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
            socketRef={socketRef}
            transport={transport}
            shells={shells}
            onToggleSidebar={isDesktop ? toggleSidebar : null}
            sidebarCollapsed={sidebarCollapsed}
            onToggleRightPanel={rightPanel?.onToggle}
            rightPanelOpen={rightPanel?.open}
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
            className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row gap-1 overflow-x-auto overflow-y-hidden px-1 pb-0 scrollbar-thin" : "relative"}`}
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
                      <div className={`absolute inset-x-0 top-0 bottom-16 overflow-hidden p-px ${focusBorderClass(isFocused && workspaceOpenedSessions.length > 1, sessionStatus[sessionId]?.state || "idle")}`}>
                        {renderPane(sessionId, isVisible, isFocused)}
                      </div>
                      {/* Per-pane input slot — absolute, reserved below the fixed-height terminal.
                          Full keyboard on the focused pane, ghost on the others. */}
                      <div className="absolute inset-x-0 bottom-0 z-20 h-16 px-1 pb-2 flex items-end">
                        {isFocused ? renderKeyboard(sessionId) : (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => {
                              nav.handleSelectSession(sessionId);
                              setTimeout(focusKeyboardInput, 60);
                            }}
                            className="group block w-full p-2 text-left"
                            aria-label="Focus this terminal input"
                          >
                            <span className="block w-full pl-9 pr-16 py-2 text-sm text-text-muted/60 rounded-[3px] border border-dashed border-border/50 group-hover:border-brand-500/60 group-hover:bg-surface-2/70 group-hover:text-text-muted transition-colors">
                              {t("mobileKeyboard.typeCommand")}
                            </span>
                          </button>
                        )}
                      </div>
                    </>
                  ) : renderPane(sessionId, isVisible, isFocused)}

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

        {/* Inline editor, opened from the tree. Mobile takes the whole screen instead of a column. */}
        {editorPanel?.filePath && (
          <div className={isDesktop ? "" : "absolute inset-0 z-40 animate-in slide-in-from-bottom duration-200"}>
            <TerminalEditorPanel
              filePath={editorPanel.filePath}
              workspace={panelRoot}
              fileSocket={fileSocket}
              width={editorPanel.width}
              onResize={editorPanel.onResize}
              onClose={editorPanel.onClose}
              onOpenFull={editorPanel.onOpenFull}
              isDesktop={isDesktop}
            />
          </div>
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
              workspacePath={panelRoot}
              fileSocket={fileSocket}
              activeFile={editorPanel?.filePath}
              tab={rightPanel.tab}
              onTabChange={rightPanel.onTabChange}
              width={rightPanel.width}
              onResize={rightPanel.onResize}
              onClose={rightPanel.onToggle}
              onOpenFiles={onOpenFiles ? () => onOpenFiles(panelRoot) : null}
              onOpenFile={editorPanel?.onOpen}
              onNewTerminal={rightPanel.onNewTerminal}
              onAddWorkspace={onAddWorkspace}
              homeDir={homeDir}
              changedPerRepo={gitCounts.perRepo}
              hiddenRepos={activeWorkspace?.hiddenRepos || []}
              onHiddenReposChange={activeWorkspace && onSetHiddenRepos
                ? (paths) => onSetHiddenRepos(activeWorkspace.id, paths)
                : null}
              isDesktop={isDesktop}
            />
          </div>
        )}
      </div>

      {/* One status bar for the whole view, spanning sidebar + panes + side panels */}
      {isDesktop && !showEmptyState && (
        <TerminalStatusBar
          cwd={activeSessionId ? cwdBySession[activeSessionId] || "" : ""}
          fileSocket={fileSocket}
          connected={connected}
          sessionState={activeSessionId ? sessionStatus[activeSessionId]?.state : "idle"}
          transport={transport}
          sessionName={activeSession ? activeSession?.name : ""}
          agentVersion={agentVersion}
          platform={platform}
        />
      )}
    </div>
  );
}
