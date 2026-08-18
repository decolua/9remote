"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Menu, PanelLeft, PanelRight, Settings, Monitor, Plus, Pencil, Trash2, X, Download, Globe } from "@/shared/components/ui/Icon";
import NotificationsBell from "./NotificationsBell";
import SitesList from "./SitesList";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import { isAgentOutdated } from "./AgentOutdatedBanner";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";

export default function TerminalHeader({
  sessions = [],
  allSessions = [],
  activeSessionId,
  connected,
  notifications = {},
  sessionStatus = {},
  onSwitchSession,
  onCreateSession,
  onBack,
  onOpenRemote,
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
  socketRef,
  transport = "ws",
  isActive = true,
  shells = [],
  workspaces = [],
  activeWorkspaceId = null,
  onRenameSession,
  onDeleteSession,
  onCreateNamedSession,
  onToggleSidebar = null,
  sidebarCollapsed = false,
  onToggleRightPanel,
  rightPanelOpen = false,
  updateAvailable = null,
  canSelfUpdate = false,
  fileSocket = null,
  homeDir = null,
}) {
  const { t } = useI18n();
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  // Tab right-click context menu (rename/delete)
  const [tabMenu, setTabMenu] = useState({ sessionId: null, x: 0, y: 0 });
  const [sitesOpen, setSitesOpen] = useState(false);
  const tabMenuRef = useRef(null);
  const tabMenuPos = useClampedMenu(tabMenuRef, tabMenu.x, tabMenu.y);
  const [editingTabId, setEditingTabId] = useState(null);
  const [editTabName, setEditTabName] = useState("");
  const [tabDeleteConfirm, setTabDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  // New terminal modal (named create)
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const tabInputRef = useRef(null);

  // Suggested default name based on terminal count in active group
  const suggestTerminalName = (workspaceId) => `${t("terminal.defaultName")} ${sessions.filter((s) => sessionWorkspaceId(s) === (workspaceId ?? null)).length + 1}`;

  // Reliable focus+select on conditional mount (autoFocus is flaky)
  useEffect(() => { if (editingTabId) requestAnimationFrame(() => { tabInputRef.current?.focus(); const el = tabInputRef.current; if (el) el.setSelectionRange(el.value.length, el.value.length); }); }, [editingTabId]);

  // Ctrl+←/→ prev/next tab (wrap), Ctrl+1..9 jump tab N (9 = last if longer)
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e) => {
      // Shortcuts active only while a text input/textarea is focused
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
      // Double rAF keeps focus on input, beating pane focus
      requestAnimationFrame(() => requestAnimationFrame(() => el.focus()));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, sessions, activeSessionId, onSwitchSession]);
  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

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
    setEditingTabId(session.id);
    setEditTabName(session.name || "");
    setTabMenu({ sessionId: null, x: 0, y: 0 });
  };

  const saveTabRename = (sessionId) => {
    if (editTabName.trim()) onRenameSession?.(sessionId, editTabName.trim());
    setEditingTabId(null);
    setEditTabName("");
  };

  const openTabDeleteConfirm = (session) => {
    setTabDeleteConfirm({ isOpen: true, sessionId: session.id, sessionName: session.name || "" });
    setTabMenu({ sessionId: null, x: 0, y: 0 });
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || null;

  const handleModalCreate = (name, shellId, agent, yolo, cwd) => {
    if (onCreateNamedSession) onCreateNamedSession(name, activeWorkspaceId, shellId, cwd || null, agent, yolo);
    else onCreateSession?.(activeWorkspaceId);
  };

  useEffect(() => {
    if (!activeTabRef.current || !tabsContainerRef.current) return;
    // Defer 1 frame so a freshly-mounted tab (new session) is measured before scrolling
    const id = requestAnimationFrame(() => {
      activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: false,
      socketRef,
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      agentVersion,
      transport,
    });

    setCallbacks({
      onRemote: onOpenRemote,
      onFiles: onOpenFiles,
      onSites: null,
      onCodespace: null,
      onLogout,
      onStopCodespace,
      onUpdate,
      onRestart,
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, onUpdate, onRestart, tunnelUrl, apiKey, connectionMode, agentVersion, socketRef, transport, subscribeToPush, unsubscribeFromPush, setContext, setCallbacks]);

  return (
    // Desktop left inset matches the panes row (px-1) plus the pane's p-px border
    <div className="px-2 sm:pl-[5px] sm:pr-2 pt-0 flex items-center gap-0 flex-shrink-0 bg-bg">
      {onToggleSidebar && sidebarCollapsed && (
        <button
          onClick={() => { vibrate(); onToggleSidebar(); }}
          className="p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
          title={t("common.open")}
        >
          <PanelLeft size={16} />
        </button>
      )}

      {/* Nothing to go back to at the bottom of the desktop stack — this view IS the
          bottom there, and the button would walk the user out of the app. */}
      {onBack && (
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-1.5 pl-1 pr-3 sm:pl-1.5 sm:pr-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
          title={t("common.back")}
        >
          <ChevronLeft size={16} />
        </button>
      )}

      {/* overflow-auto whitelists this for mobile touchmove (see page.js preventScroll) */}
      <div ref={tabsContainerRef} className="flex-1 overflow-auto overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-dark-400 scrollbar-track-transparent">
        <div className="flex gap-0 min-w-max items-center">
          {sessions.map((session) => {
            const isActiveTab = session.id === activeSessionId;
            const st = sessionStatus[session.id]?.state || "idle";
            const v = statusVisual(st);
            return (
              <button
                key={session.id}
                ref={isActiveTab ? activeTabRef : null}
                onMouseDown={(e) => { if (editingTabId !== session.id) e.preventDefault(); }}
                onClick={() => {
                  if (editingTabId === session.id) return;
                  vibrate();
                  onSwitchSession?.(session.id);
                }}
                onContextMenu={(e) => handleTabContextMenu(e, session)}
                onTouchStart={(e) => { if (editingTabId === session.id) return; handleTabTouchStart(e, session); }}
                onTouchMove={editingTabId === session.id ? undefined : clearTabLongPress}
                onTouchEnd={editingTabId === session.id ? undefined : clearTabLongPress}
                className={`term-tab px-2 sm:px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-out flex items-center gap-1.5 sm:gap-2 whitespace-nowrap ${
                  isActiveTab ? "term-tab-active" : ""
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} title={t(v.label)} />
                {editingTabId === session.id ? (
                  <input
                    type="text"
                    ref={tabInputRef}
                    value={editTabName}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => setEditTabName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTabRename(session.id);
                      if (e.key === "Escape") { setEditingTabId(null); setEditTabName(""); }
                    }}
                    onBlur={() => saveTabRename(session.id)}
                    className="bg-transparent border-b border-brand-500 outline-none max-w-[120px] text-text"
                  />
                ) : (
                  <span className="truncate max-w-[120px]">{session.name || t("terminal.defaultName")}</span>
                )}
              </button>
            );
          })}
          {onCreateSession && (
            <div className="sticky right-0 z-10 ml-1 pl-1 flex-shrink-0 bg-bg">
              <button
                onClick={() => { vibrate(); setCreateModalOpen(true); }}
                disabled={!connected}
                className="p-1.5 text-text-muted hover:bg-surface-2 hover:text-text transition-all duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed rounded-brand"
                title={t("terminal.newTerminal")}
              >
                <Plus size={16} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
      {connected && onUpdate && canSelfUpdate && (isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || !!updateAvailable) && (
        <button
          onClick={() => { vibrate(); onUpdate(); }}
          className="hidden sm:flex px-2 sm:px-2.5 py-1 bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium rounded-brand items-center gap-1.5 flex-shrink-0 transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("menu.updateAvailableTitle")}
        >
          <Download size={13} />
          <span>Update 9Remote</span>
        </button>
      )}
      {onOpenRemote && (
        <button
          onClick={() => { vibrate(); onOpenRemote(); }}
          className="p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("menu.remoteDesktop")}
        >
          <Monitor size={16} />
        </button>
      )}

      <button
        onClick={() => { vibrate(); setSitesOpen(true); }}
        disabled={!connected}
        className="hidden sm:block p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed"
        title={t("menu.sites")}
      >
        <Globe size={16} />
      </button>

      <NotificationsBell
        sessions={sessions}
        allSessions={allSessions}
        sessionStatus={sessionStatus}
        onSwitchSession={onSwitchSession}
        workspaces={workspaces}
      />

      {/* Files / git / worktrees panel */}
      {onToggleRightPanel && (
        <button
          onClick={() => { vibrate(); onToggleRightPanel(); }}
          className={`hidden sm:block p-1.5 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] hover:bg-surface-2 ${
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
        className={`p-1.5 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] ${onToggleSidebar ? "sm:hidden" : ""}`}
        title={t("menu.title")}
      >
        <Settings size={16} />
      </button>
      </div>

      {/* Tab right-click context menu */}
      {tabMenu.sessionId && (
        <div
          ref={tabMenuRef}
          className="fixed z-[60] bg-surface-2 border border-border-subtle rounded-brand shadow-lg py-1 min-w-[140px]"
          style={{ left: tabMenuPos.left, top: tabMenuPos.top }}
        >
          <button
            onClick={() => startTabRename(sessions.find((s) => s.id === tabMenu.sessionId))}
            className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-3 flex items-center gap-2"
          >
            <Pencil size={14} /> {t("sessions.editName")}
          </button>
          <button
            onClick={() => openTabDeleteConfirm(sessions.find((s) => s.id === tabMenu.sessionId))}
            className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 flex items-center gap-2"
          >
            <Trash2 size={14} /> {t("sessions.deleteTitle")}
          </button>
        </div>
      )}

      {/* New terminal modal (shared) */}
      {createModalOpen && (
        <NewTerminalModal
          onClose={() => setCreateModalOpen(false)}
          onCreate={handleModalCreate}
          shells={shells}
          socketRef={socketRef}
          suggestName={suggestTerminalName(activeWorkspaceId)}
          workspacePath={activeWorkspace?.path || null}
          workspaceName={activeWorkspace?.name || ""}
          fileSocket={fileSocket}
          homeDir={homeDir}
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

      <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} socketRef={socketRef} isOpen={sitesOpen} onClose={() => setSitesOpen(false)} />
    </div>
  );
}
