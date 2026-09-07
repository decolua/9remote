"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Menu, PanelLeft, PanelRight, Settings, Monitor, Smartphone, Plus, Pencil, Trash2, X, Download, Globe, RotateCw, Github, Star } from "@/shared/components/ui/Icon";
import NotificationsBell from "./NotificationsBell";
import SessionStatusBadge from "./SessionStatusBadge";
import SitesList from "./SitesList";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useSitesModalStore } from "@/shared/stores/sitesModalStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useI18n } from "@/shared/i18n";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { withHint, tabIndexHint } from "@/features/terminal/constants/shortcuts";
import { statusVisual } from "@/shared/utils/statusVisual";
import { isAgentOutdated } from "./AgentOutdatedBanner";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { useDragReorder } from "@/features/terminal/hooks/useDragReorder";
import { useGithubStars } from "@/shared/hooks/useGithubStars";
import { GITHUB_REPO_URL } from "@/shared/constants/github";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";

function TerminalHeader({
  sessions = [],
  allSessions = [],
  activeSessionId,
  connected,
  notifications: propNotifications,
  sessionStatus: propStatus,
  onSwitchSession,
  onCreateSession,
  onBack,
  onOpenRemote,
  onOpenMobile,
  onOpenFiles,
  onLogout,
  onStopCodespace,
  onUpdate,
  onRestart,
  codespaceInfo,
  tunnelUrl,
  apiKey,
  connectionMode,
  subscribeToPush,
  unsubscribeFromPush,
  agentVersion,
  busRef,
  carrier = "ws",
  isActive = true,
  shells = [],
  workspaces = [],
  activeWorkspaceId = null,
  onRenameSession,
  onDeleteSession,
  onCreateNamedSession,
  onResumeAgentSession = null,
  onToggleSidebar = null,
  sidebarCollapsed = false,
  onToggleRightPanel,
  onReorderSession,
  rightPanelOpen = false,
  updateAvailable = null,
  canSelfUpdate = false,
  fileBus = null,
  homeDir = null,
}) {
  const { t } = useI18n();
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeSessionStatus = useNotificationStore((s) => s.sessionStatus);
  const notifications = propNotifications || storeNotifications;
  const sessionStatus = propStatus || storeSessionStatus;

  const { formattedStars } = useGithubStars();
  // Chords only fire on desktop, so only a pointer device gets the hint.
  const hasKeyboard = useInputMode() === "mouse";
  const hint = (label, id) => (hasKeyboard ? withHint(label, id) : label);
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  // Tab right-click context menu (rename/delete)
  const [tabMenu, setTabMenu] = useState({ sessionId: null, x: 0, y: 0 });
  const tabMenuRef = useRef(null);
  const tabMenuPos = useClampedMenu(tabMenuRef, tabMenu.x, tabMenu.y);
  const [tabDeleteConfirm, setTabDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  // Tab rename prompt (shared modal; inline input lost the iOS gesture window for focus)
  const [renameDialog, setRenameDialog] = useState({ sessionId: null, name: "", value: "" });
  // New terminal modal (named create)
  const [createModalOpen, setCreateModalOpen] = useState(false);
  // Drag-reorder the tab strip. No grip here — the strip is too tight for one — so a
  // press only becomes a drag past the threshold; below it the tab still switches.
  const { dragId, registerEl, startDrag, consumeClick } = useDragReorder({
    axis: "x",
    // Higher than the sidebar's: that has a grip to grab, a tab is its own handle, so a
    // twitch while clicking must still read as "switch to this tab".
    threshold: 6,
    onCommit: onReorderSession
  });

  // Every terminal that actually exists right now — a history row naming one of them
  // focuses it instead of resuming a second copy of the same conversation.
  const liveSessionIds = useMemo(() => new Set(allSessions.map((s) => s.id)), [allSessions]);

  // Suggested default name based on terminal count in active group
  const suggestTerminalName = (workspaceId) => `${t("terminal.defaultName")} ${sessions.filter((s) => sessionWorkspaceId(s) === (workspaceId ?? null)).length + 1}`;

  // Ctrl+←/→ prev/next tab (wrap), Ctrl+1..9 jump tab N (9 = last if longer)
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e) => {
      const el = document.activeElement;
      if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (sessions.length < 2) return;
      const idx = sessions.findIndex((s) => s.id === activeSessionId);
      let target;
      if (e.key === "ArrowRight") target = sessions[(idx + 1) % sessions.length];
      else if (e.key === "ArrowLeft") target = sessions[(idx - 1 + sessions.length) % sessions.length];
      else if (e.key >= "1" && e.key <= "9") target = sessions[Math.min(+e.key - 1, sessions.length - 1)];
      else return;
      e.preventDefault();
      if (target && target.id !== activeSessionId) onSwitchSession?.(target.id);
      requestAnimationFrame(() => requestAnimationFrame(() => el.focus()));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, sessions, activeSessionId, onSwitchSession]);

  // Actions only (stable identities): this component WRITES context/callbacks, so
  // subscribing to the whole store would re-render it on its own every write.
  const openMenu = useSlideMenuStore((s) => s.open);
  const sitesOpen = useSitesModalStore((s) => s.isOpen);
  const openSites = useSitesModalStore((s) => s.open);
  const closeSites = useSitesModalStore((s) => s.close);
  // Hidden by id rather than listed by id, so a button added later shows up
  // instead of being invisible until the user finds the setting.
  const hiddenHeaderButtons = useTerminalStore((s) => s.hiddenHeaderButtons);
  // A windowless emulator shows nothing on the host, so the button itself is
  // the only indication that one is running.
  const mobileDeviceCount = useTerminalStore((s) => s.mobileDeviceCount);
  const showButton = (id) => !hiddenHeaderButtons.includes(id);
  const setContext = useSlideMenuStore((s) => s.setContext);
  const setCallbacks = useSlideMenuStore((s) => s.setCallbacks);

  // Mod+Alt+T opens the new-terminal modal (browser reserves bare Mod+T)
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setCreateModalOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  // Close tab context menu on outside click / Escape
  useEffect(() => {
    if (!tabMenu.sessionId) return;
    const onDocClick = (e) => {
      if (tabMenuRef.current && !tabMenuRef.current.contains(e.target)) setTabMenu({ sessionId: null, x: 0, y: 0 });
    };
    const onKey = (e) => { if (e.key === "Escape") setTabMenu({ sessionId: null, x: 0, y: 0 }); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [tabMenu.sessionId]);

  const handleTabContextMenu = (e, session) => {
    e.preventDefault();
    vibrate();
    setTabMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
  };

  // Long-press on touch → open same context menu (touch has no reliable contextmenu event)
  const longPressRef = useRef(null);
  const handleTabTouchStart = (e, session) => {
    const touch = e.touches[0];
    longPressRef.current = setTimeout(() => {
      vibrate();
      setTabMenu({ sessionId: session.id, x: touch.clientX, y: touch.clientY });
    }, 500);
  };
  const clearTabLongPress = () => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
  };

  const startTabRename = (session) => {
    setRenameDialog({ sessionId: session.id, name: session.name || "", value: session.name || "" });
    setTabMenu({ sessionId: null, x: 0, y: 0 });
  };

  const saveTabRename = () => {
    const value = renameDialog.value.trim();
    if (renameDialog.sessionId && value) onRenameSession?.(renameDialog.sessionId, value);
    setRenameDialog({ sessionId: null, name: "", value: "" });
  };

  const openTabDeleteConfirm = (session) => {
    setTabDeleteConfirm({ isOpen: true, sessionId: session.id, sessionName: session.name || "" });
    setTabMenu({ sessionId: null, x: 0, y: 0 });
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;

  const handleModalCreate = (name, shellId, agent, yolo, cwd, nameIsAuto) => {
    if (onCreateNamedSession) onCreateNamedSession(name, activeWorkspaceId, shellId, cwd || null, agent, yolo, nameIsAuto);
    // No arg: onCreateSession is handleQuickCreateSession(shellId, …), which reads the
    // active workspace from the store itself — passing an id here would land as a shell.
    else onCreateSession?.();
  };

  useEffect(() => {
    if (!activeTabRef.current || !tabsContainerRef.current) return;
    // MUI-Tabs-style manual scroll: scrollTo a self-clamped target instead of
    // scrollIntoView("center") — WebKit animates that unclamped request past the
    // strip's max scroll and bounces back (visible on the first/last tab).
    // Defer 1 frame so a freshly-mounted tab (new session) is measured before scrolling
    const id = requestAnimationFrame(() => {
      const scroller = tabsContainerRef.current;
      const tab = activeTabRef.current;
      if (!scroller || !tab) return;
      const delta = tab.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
      const centered = scroller.scrollLeft + delta - (scroller.clientWidth - tab.offsetWidth) / 2;
      const max = scroller.scrollWidth - scroller.clientWidth;
      scroller.scrollTo({ left: Math.max(0, Math.min(centered, max)), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
    // Identity-only `sessions` churn (cwd/status ticks) must not re-scroll the strip
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, sessions.length]);

  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: false,
      busRef,
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      agentVersion,
      carrier,
    });

    setCallbacks({
      onRemote: onOpenRemote,
      onFiles: onOpenFiles,
      onCodespace: null,
      onLogout,
      onStopCodespace,
      onUpdate,
      onRestart,
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, onUpdate, onRestart, tunnelUrl, apiKey, connectionMode, agentVersion, busRef, carrier, subscribeToPush, unsubscribeFromPush, setContext, setCallbacks]);

  return (
    <div className={`h-9 ${PANEL_HEADER_H_CLASS} px-2 sm:pl-0 sm:pr-2 flex items-stretch gap-0 flex-shrink-0 bg-bg border-b border-border-subtle`}>
      {onToggleSidebar && sidebarCollapsed && (
        <button
          onClick={() => { vibrate(); onToggleSidebar(); }}
          className="p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition duration-150 ease-out active:scale-[0.94] flex-shrink-0 self-center"
          title={hint(t("common.open"), "toggleSidebar")}
        >
          <PanelLeft size={16} />
        </button>
      )}

      {/* Nothing to go back to at the bottom of the desktop stack — this view IS the
          bottom there, and the button would walk the user out of the app. */}
      {onBack && (
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-1 pl-1.5 pr-3.5 sm:p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition duration-150 ease-out active:scale-[0.94] flex-shrink-0 self-center"
          title={t("common.back")}
        >
          <ChevronLeft size={20} className="sm:hidden" />
          <ChevronLeft size={16} className="hidden sm:block" />
        </button>
      )}

      {/* overflow-auto whitelists this for mobile touchmove (see page.js preventScroll) */}
      <div ref={tabsContainerRef} className="flex-1 overflow-auto overflow-x-auto overflow-y-hidden scrollbar-none h-full">
        <div className="flex gap-0 min-w-max items-stretch h-full">
          {sessions.map((session, tabIndex) => {
            const isActiveTab = session.id === activeSessionId;
            const st = sessionStatus[session.id]?.state || "idle";
            const v = statusVisual(st);
            const tabName = session.name || t("terminal.defaultName");
            const chord = hasKeyboard ? tabIndexHint(tabIndex) : null;
            return (
              <button
                key={session.id}
                title={chord || undefined}
                ref={(el) => {
                  registerEl(session.id)(el);
                  if (isActiveTab) activeTabRef.current = el;
                }}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => {
                  // Mouse only: on touch this strip is a horizontal scroller, and
                  // swallowing the gesture would trap it. Touch reorders in the sidebar.
                  if (e.pointerType !== "mouse" || !onReorderSession || !connected) return;
                  clearTabLongPress();
                  startDrag(e, session.id, sessions.map((s) => s.id));
                }}
                onClick={() => {
                  if (consumeClick()) return;
                  vibrate();
                  onSwitchSession?.(session.id);
                }}
                onContextMenu={(e) => handleTabContextMenu(e, session)}
                onTouchStart={(e) => handleTabTouchStart(e, session)}
                onTouchMove={clearTabLongPress}
                onTouchEnd={clearTabLongPress}
                className={`term-tab px-2 sm:px-2.5 text-xs font-medium duration-150 ease-out flex items-center gap-1.5 sm:gap-2 whitespace-nowrap h-full ${
                  isActiveTab ? "term-tab-active" : ""
                } ${dragId === session.id ? "relative z-20 opacity-90 shadow-lg" : "transition"}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} title={t(v.label)} />
                <span className="truncate max-w-[80px] sm:max-w-[120px]" data-tip={tabName}>{tabName}</span>
              </button>
            );
          })}
          {onCreateSession && (
            <div className="sticky right-0 z-10 ml-1 pl-1 flex items-center flex-shrink-0 bg-bg">
              <button
                onClick={() => { vibrate(); setCreateModalOpen(true); }}
                disabled={!connected}
                className="p-1.5 text-text hover:bg-surface-2 hover:text-brand-500 transition duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed rounded-brand"
                title={hint(t("terminal.newTerminal"), "newTerminal")}
              >
                <Plus size={17} strokeWidth={2.4} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0 self-center">
      {connected && onUpdate && canSelfUpdate && (isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || !!updateAvailable) && (
        <button
          onClick={() => { vibrate(); onUpdate(); }}
          className="hidden sm:flex px-2 sm:px-2.5 py-1 bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium rounded-brand items-center gap-1.5 flex-shrink-0 transition duration-150 ease-out active:scale-[0.94]"
          title={t("menu.updateAvailableTitle")}
        >
          <Download size={13} />
          <span>Update 9Remote</span>
        </button>
      )}
      {/* GitHub star — re-enable later
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden sm:flex items-center gap-1 px-2 py-1 text-xs text-text hover:bg-surface-2 rounded-brand transition duration-150 ease-out active:scale-[0.94] flex-shrink-0"
        title="Star on GitHub"
      >
        <Github size={15} />
        <Star size={13} className="text-yellow-500 fill-yellow-500" />
        {formattedStars && <span className="font-mono text-[11px]">{formattedStars}</span>}
      </a> */}
      {showButton("remote") && onOpenRemote && (
        <button
          onClick={() => { vibrate(); onOpenRemote(); }}
          className="hidden sm:block p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition duration-150 ease-out active:scale-[0.94]"
          title={t("menu.remoteDesktop")}
        >
          <Monitor size={16} />
        </button>
      )}
      {showButton("mobile") && onOpenMobile && (
        <button
          onClick={() => { vibrate(); onOpenMobile(); }}
          className={`hidden sm:block p-1.5 hover:bg-surface-2 rounded-brand transition duration-150 ease-out active:scale-[0.94] ${
            mobileDeviceCount > 0 ? "text-green-400" : "text-text hover:text-text"
          }`}
          title={mobileDeviceCount > 0
            ? t("mobile.deviceRunning", { count: mobileDeviceCount })
            : t("mobile.androidDevice")}
        >
          <Smartphone size={16} />
        </button>
      )}

      {showButton("sites") && (
      <button
        onClick={() => { vibrate(); openSites(); }}
        disabled={!connected}
        className="hidden sm:block p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed"
        title={t("menu.sites")}
      >
        <Globe size={16} />
      </button>
      )}

      {showButton("notifications") && (
        <SessionStatusBadge
          sessionStatus={sessionStatus}
          allSessions={allSessions}
          onSwitchSession={onSwitchSession}
        />
      )}

      {showButton("notifications") && (
        <NotificationsBell
          sessions={sessions}
          allSessions={allSessions}
          sessionStatus={sessionStatus}
          onSwitchSession={onSwitchSession}
          workspaces={workspaces}
        />
      )}

      {/* Files / git / worktrees panel */}
      {onToggleRightPanel && (
        <button
          onClick={() => { vibrate(); onToggleRightPanel(); }}
          className={`hidden sm:block p-1.5 rounded-brand transition duration-150 ease-out active:scale-[0.94] hover:bg-surface-2 ${
            rightPanelOpen ? "text-brand-500" : "text-text hover:text-text"
          }`}
          title={t("workspaces.tabFiles")}
        >
          <PanelRight size={16} />
        </button>
      )}

      {/* Settings lives at the bottom of the sidebar on desktop; kept here for mobile */}
      <button
        onClick={() => { vibrate(); openMenu(); }}
        className={`p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition duration-150 ease-out active:scale-[0.94] ${onToggleSidebar ? "sm:hidden" : ""}`}
        title={t("menu.title")}
      >
        <Settings size={16} />
      </button>
      </div>

      {/* Tab right-click context menu */}
      {tabMenu.sessionId && (
        <div
          ref={tabMenuRef}
          className="fixed z-[60] menu-popover p-1 min-w-[140px] animate-in fade-in zoom-in-95 duration-100"
          style={{ left: tabMenuPos.left, top: tabMenuPos.top }}
        >
          <button
            onClick={() => startTabRename(sessions.find((s) => s.id === tabMenu.sessionId))}
            className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
          >
            <Pencil size={13} /> {t("sessions.editName")}
          </button>
          {sessionStatus[tabMenu.sessionId]?.conversationId && (
            <button
              onClick={() => {
                vibrate();
                busRef?.current?.emit("session-resume", { sessionId: tabMenu.sessionId });
                setTabMenu({ sessionId: null, x: 0, y: 0 });
              }}
              className="w-full text-left px-2.5 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
            >
              <RotateCw size={13} /> {t("sessions.resumeSession")}
            </button>
          )}
          <button
            onClick={() => openTabDeleteConfirm(sessions.find((s) => s.id === tabMenu.sessionId))}
            className="w-full text-left px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10 rounded-[6px] flex items-center gap-2"
          >
            <Trash2 size={13} /> {t("sessions.deleteTitle")}
          </button>
        </div>
      )}

      {/* Tab rename dialog (shared prompt) */}
      {renameDialog.sessionId && (
        <PromptDialog
          title={t("sessions.editName")}
          placeholder={renameDialog.name}
          value={renameDialog.value}
          onChange={(value) => setRenameDialog({ ...renameDialog, value })}
          onSubmit={saveTabRename}
          onClose={() => setRenameDialog({ sessionId: null, name: "", value: "" })}
        />
      )}

      {/* New terminal modal (shared) */}
      {createModalOpen && (
        <NewTerminalModal
          onClose={() => setCreateModalOpen(false)}
          onCreate={handleModalCreate}
          shells={shells}
          busRef={busRef}
          suggestName={suggestTerminalName(activeWorkspaceId)}
          workspacePath={activeWorkspace?.path || null}
          workspaceName={activeWorkspace?.name || ""}
          fileBus={fileBus}
          homeDir={homeDir}
          onResumeAgentSession={onResumeAgentSession}
          onSelectSession={onSwitchSession}
          liveSessionIds={liveSessionIds}
          activeSessionId={activeSessionId}
          connected={connected}
        />
      )}

      {/* Tab delete confirm */}
      {tabDeleteConfirm.isOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70"
          onClick={() => setTabDeleteConfirm({ isOpen: false, sessionId: null, sessionName: "" })}
        >
          <div className="bg-surface rounded-brand-lg p-5 w-80 shadow-elev" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-text mb-4">
              {t("sessions.deleteMessage", { name: tabDeleteConfirm.sessionName })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (tabDeleteConfirm.sessionId) onDeleteSession?.(tabDeleteConfirm.sessionId);
                  setTabDeleteConfirm({ isOpen: false, sessionId: null, sessionName: "" });
                }}
                className="flex-1 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 rounded-brand transition-colors"
              >
                {t("common.delete")}
              </button>
              <button
                onClick={() => setTabDeleteConfirm({ isOpen: false, sessionId: null, sessionName: "" })}
                className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} busRef={busRef} isOpen={sitesOpen} onClose={closeSites} />
    </div>
  );
}

// Props are stabilized upstream (memoized panel descriptors, `nav`, store actions), so
// this only re-renders when something it actually shows changed.
export default memo(TerminalHeader);
