"use client";

import dynamic from "next/dynamic";
import { useI18n } from "@/shared/i18n";
import { PANE_MIN_WIDTH } from "@/features/terminal/constants/terminalConfig";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";

const TerminalHeader = dynamic(() => import("@/features/terminal/components/TerminalHeader"), { ssr: false });
const TerminalPane = dynamic(() => import("@/features/terminal/components/TerminalPane"), { ssr: false });
const TerminalSidebar = dynamic(() => import("@/features/terminal/components/TerminalSidebar"), { ssr: false });
const TerminalStatusBar = dynamic(() => import("@/features/terminal/components/TerminalStatusBar"), { ssr: false });

// Sequential join within a freshly-active group: focus first (0ms), then stagger the rest
// so concurrent joins don't pile up and stall the main thread.
const STAGGER_MS = 120;

// Which panes render, which of those mount, and their join order. Active-group panes drive
// tabs/visibility; the LRU union stays mounted so a group switch never remounts.
function derivePaneLayout({ sessions, openedSessions, livePanes, mountedGroups, activeGroupId, isDesktop }) {
  const groupSessionIds = new Set(sessions.filter(s => (s.groupId || null) === activeGroupId).map(s => s.id));
  const groupOpenedSessions = openedSessions.filter(sid => groupSessionIds.has(sid));
  const liveSet = new Set([...groupOpenedSessions, ...livePanes.filter(sid => openedSessions.includes(sid))]);
  const renderedSessions = openedSessions.filter(sid => liveSet.has(sid));

  // A pane mounts only if its group has been visited once (the active group auto-marks mounted).
  // Desktop keeps panes from other VISITED groups mounted (split/LRU); mobile mounts ONLY the
  // active group — one visible pane at a time, keeping others alive wastes memory + joins.
  const sessionGroup = new Map(sessions.map(s => [s.id, s.groupId ?? null]));
  const mountedSet = new Set(openedSessions.filter(sid => {
    if (groupSessionIds.has(sid)) return true;
    if (!isDesktop) return false;
    return !!mountedGroups[sessionGroup.get(sid) ?? "__ungrouped__"];
  }));

  const groupIndex = new Map(groupOpenedSessions.map((sid, i) => [sid, i]));
  return { groupSessionIds, groupOpenedSessions, renderedSessions, mountedSet, groupIndex };
}

// Panes already alive (revisit) join with no delay — their PTY is already running.
const mountDelayFor = (sessionId, isFocused, groupIndex) =>
  !isFocused && groupIndex.has(sessionId) ? groupIndex.get(sessionId) * STAGGER_MS : 0;

const focusBorderClass = (isFocused, state) => {
  if (isFocused) return "outline outline-1 -outline-offset-1 outline-brand-500";
  if (state === "working") return "status-border-working";
  if (state === "blocked") return "status-border-blocked";
  if (state === "done") return "status-border-done";
  return "";
};

// Terminal view shell: sidebar + header + multi-pane row + input bar + status bar.
export default function TerminalWorkspace({
  socket, socketRef, connected, transport, platform, agentVersion,
  sessions, groups, activeSessionId, activeSession, activeGroupId,
  openedSessions, livePanes, mountedGroups, cwdBySession,
  sessionStatus, notifications, clearNotification,
  isDesktop, isTerminalView, slideClass, shells, fileSocket,
  sidebarCollapsed, sidebarWidth, setSidebarWidth, toggleSidebar,
  paneRegistry, bindSwipeTab, nav,
  onBack, onOpenRemote, onOpenFiles, onLogout, onStopCodespace, onUpdate, onRestart,
  onCreateGroup, onDeleteGroup, onMoveSession, onReorderSession,
  codespaceInfo, tunnelUrl, apiKey, connectionMode,
  subscribeToPush, unsubscribeFromPush, updateAvailable, canSelfUpdate
}) {
  const { t } = useI18n();
  const {
    panesContainerRef, registerPaneApi, registerPaneElement, registerKeyboardTextApi,
    handlePasteFallback, handleInputFocusChange, focusPane, focusKeyboardInput
  } = paneRegistry;

  const { groupSessionIds, groupOpenedSessions, renderedSessions, mountedSet, groupIndex } =
    derivePaneLayout({ sessions, openedSessions, livePanes, mountedGroups, activeGroupId, isDesktop });

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
      mountDelay={mountDelayFor(sessionId, isFocused, groupIndex)}
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
      className={`absolute inset-0 ${isDesktop ? "flex flex-row" : "flex flex-col"} ${isTerminalView ? "translate-x-0 opacity-100 z-10" : "translate-x-full opacity-0 z-0 pointer-events-none"}`}
    >
      {isDesktop && (
        <div
          className="hidden sm:block overflow-hidden flex-shrink-0 transition-[width] duration-200 ease-out"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <TerminalSidebar
            allSessions={sessions}
            groups={groups}
            activeSessionId={activeSessionId}
            activeGroupId={activeGroupId}
            sessionStatus={sessionStatus}
            notifications={notifications}
            onSelectSession={nav.handleSelectSession}
            onCreateSession={nav.handleQuickCreateSession}
            onCreateNamedSession={nav.handleCreateSession}
            shells={shells}
            onRenameSession={nav.handleRenameSession}
            onDeleteSession={nav.handleDeleteSession}
            onReorderSession={onReorderSession}
            onMoveSession={onMoveSession}
            onCreateGroup={(name, cb) => onCreateGroup(name, cb)}
            onDeleteGroup={onDeleteGroup}
            connected={connected}
            width={sidebarWidth}
            onResize={setSidebarWidth}
            onCollapse={toggleSidebar}
          />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <TerminalHeader
          sessions={sessions.filter(s => (s.groupId || null) === activeGroupId)}
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
          groups={groups}
          activeGroupId={activeGroupId}
          onSelectGroup={nav.handleSelectGroup}
          hasUngrouped={sessions.some(s => !s.groupId)}
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
        />

        {/* Panes container: desktop = horizontal scroll split, mobile = overlay active pane */}
        <div
          ref={panesContainerRef}
          className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row gap-1 overflow-x-auto overflow-y-hidden px-1 pb-0 scrollbar-thin" : "relative"}`}
          {...bindSwipeTab({
            enabled: !isDesktop,
            sessionIds: groupOpenedSessions,
            activeSessionId,
            onSwitch: nav.handleSelectSession
          })}
        >
          {renderedSessions.map((sessionId) => {
            const inActiveGroup = groupSessionIds.has(sessionId);
            const isFocused = sessionId === activeSessionId;
            const isVisible = inActiveGroup && (isDesktop || isFocused);
            // Panes outside the active group stay mounted (LRU) but fully hidden
            return (
              <div
                key={sessionId}
                ref={(el) => registerPaneElement(sessionId, el)}
                className={
                  !inActiveGroup
                    ? "hidden"
                    : isDesktop
                    ? "flex-1 h-full relative"
                    : `absolute inset-0 ${isFocused ? `opacity-100 z-10 ${slideClass}` : "opacity-0 z-0 pointer-events-none"}`
                }
                style={inActiveGroup && isDesktop ? { minWidth: `${PANE_MIN_WIDTH}px` } : undefined}
              >
                {!mountedSet.has(sessionId) ? (
                  // Placeholder — group not yet visited; mounts on first entry
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

        {/* Mobile: one shared keyboard below the active pane (desktop renders its own per pane) */}
        {!isDesktop && activeSessionId && renderKeyboard(activeSessionId)}

        {isDesktop && (
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
    </div>
  );
}
