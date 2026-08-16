"use client";

import dynamic from "next/dynamic";
import { useI18n } from "@/shared/i18n";
import { PANE_MIN_WIDTH } from "@/features/terminal/constants/terminalConfig";
import { derivePaneLayout, mountDelayFor, sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";

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
  paneRegistry, bindSwipeTab, nav,
  onBack, onOpenRemote, onOpenFiles, onLogout, onStopCodespace, onUpdate, onRestart,
  onDeleteWorkspace, onMoveSession, onReorderSession, onSetHiddenRepos,
  onAddWorkspace, onOpenSettings, homeDir, recentWorkspaces,
  rightPanel, editorPanel,
  codespaceInfo, tunnelUrl, apiKey, connectionMode,
  subscribeToPush, unsubscribeFromPush, updateAvailable, canSelfUpdate
}) {
  const { t } = useI18n();
  const {
    panesContainerRef, registerPaneApi, registerPaneElement, registerKeyboardTextApi,
    handlePasteFallback, handleInputFocusChange, focusPane, focusKeyboardInput
  } = paneRegistry;

  const { workspaceSessionIds, workspaceOpenedSessions, renderedSessions, mountedSet, workspaceIndex } =
    derivePaneLayout({ sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop });

  // Root the side panels track: the active workspace's own path, else the fixed
  // workspacePath of the focused terminal (a workspace migrated from a group has no path).
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const panelRoot = activeWorkspace?.path || activeSession?.workspacePath || null;
  const showEmptyState = !sessions.length;

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
      <div className={`flex-1 min-h-0 relative ${isDesktop ? "flex flex-row" : "flex flex-col"}`}>
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
            onBack={onBack}
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
                      ? "flex-1 h-full relative"
                      : `absolute inset-0 ${isFocused ? `opacity-100 z-10 ${slideClass}` : "opacity-0 z-0 pointer-events-none"}`
                  }
                  style={inActiveWorkspace && isDesktop ? { minWidth: `${PANE_MIN_WIDTH}px` } : undefined}
                >
                  {!mountedSet.has(sessionId) ? (
                    // Placeholder — workspace not yet visited; mounts on first entry
                    <div className="w-full h-full flex items-center justify-center text-text-muted text-xs" />
                  ) : isDesktop ? (
                    <>
                      <div className={`absolute inset-x-0 top-0 bottom-16 overflow-hidden p-px ${focusBorderClass(isFocused, sessionStatus[sessionId]?.state || "idle")}`}>
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
        {rightPanel?.open && (
          <div className={isDesktop ? "" : "absolute inset-y-0 right-0 z-30 w-[85%] max-w-sm shadow-elev animate-in slide-in-from-right duration-200"}>
            <TerminalRightPanel
              workspacePath={panelRoot}
              fileSocket={fileSocket}
              activeFile={editorPanel?.filePath}
              tab={rightPanel.tab}
              onTabChange={rightPanel.onTabChange}
              width={rightPanel.width}
              onResize={rightPanel.onResize}
              onClose={rightPanel.onToggle}
              onOpenFile={editorPanel?.onOpen}
              onNewTerminal={rightPanel.onNewTerminal}
              onAddWorkspace={onAddWorkspace}
              homeDir={homeDir}
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
