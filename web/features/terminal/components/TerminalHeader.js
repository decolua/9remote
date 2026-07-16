"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Settings, Monitor, Plus, ChevronDown, Pencil, Trash2, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useI18n } from "@/shared/i18n";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";

export default function TerminalHeader({
  sessions = [],
  allSessions = [],
  activeSessionId,
  connected,
  notifications = {},
  onSwitchSession,
  onCreateSession,
  onBack,
  onOpenRemote,
  onOpenFiles,
  onLogout,
  onStopCodespace,
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
  groups = [],
  activeGroupId = null,
  onSelectGroup,
  hasUngrouped = false,
  onRenameSession,
  onDeleteSession,
  onCreateNamedSession,
}) {
  const { t } = useI18n();
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const groupMenuRef = useRef(null);
  // Tab right-click context menu (rename/delete)
  const [tabMenu, setTabMenu] = useState({ sessionId: null, x: 0, y: 0 });
  const tabMenuRef = useRef(null);
  const [editingTabId, setEditingTabId] = useState(null);
  const [editTabName, setEditTabName] = useState("");
  const [tabDeleteConfirm, setTabDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  // New terminal modal (named create)
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const tabInputRef = useRef(null);
  const activeGroupName = groups.find((g) => g.id === activeGroupId)?.name || t("groups.ungrouped");
  // A group is "finished" if any of its sessions has an unseen notification — surfaces cross-group dots
  const groupHasFinished = (gid) => allSessions.some((s) => (s.groupId || null) === gid && notifications[s.id]);

  // Suggested default name based on terminal count in active group
  const suggestTerminalName = (groupId) => `${t("terminal.defaultName")} ${sessions.filter((s) => (s.groupId || null) === groupId).length + 1}`;

  // Reliable focus+select on conditional mount (autoFocus is flaky)
  useEffect(() => { if (editingTabId) requestAnimationFrame(() => { tabInputRef.current?.focus(); tabInputRef.current?.select(); }); }, [editingTabId]);

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

  const handleModalCreate = (name, shellId) => {
    if (onCreateNamedSession) onCreateNamedSession(name, activeGroupId, shellId);
    else onCreateSession?.(activeGroupId);
  };

  useEffect(() => {
    if (!showGroupMenu) return;
    const onDocClick = (e) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setShowGroupMenu(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("touchstart", onDocClick);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("touchstart", onDocClick);
    };
  }, [showGroupMenu]);

  useEffect(() => {
    if (activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeSessionId]);

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
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, tunnelUrl, apiKey, connectionMode, agentVersion, socketRef, transport, subscribeToPush, unsubscribeFromPush, setContext, setCallbacks]);

  return (
    <div className="px-2 sm:px-4 pt-2 flex items-center gap-2 flex-shrink-0 bg-bg">
      <button
        onClick={() => { vibrate(); onBack(); }}
        className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
        title={t("common.back")}
      >
        <ChevronLeft size={18} />
      </button>

      {/* Group selector — desktop only, hidden when only one option exists */}
      {onSelectGroup && (groups.length + (hasUngrouped ? 1 : 0)) > 1 && (
        <div ref={groupMenuRef} className="relative hidden sm:block flex-shrink-0">
          <button
            onClick={() => { vibrate(); setShowGroupMenu(v => !v); }}
            className="px-2 py-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-colors flex items-center gap-1 max-w-[160px]"
            title={t("groups.title")}
          >
            <span className="truncate text-sm font-medium">{activeGroupName}</span>
            {/* Dot when a NON-active group has a finished session, so user knows to switch */}
            {[...groups, ...(hasUngrouped ? [{ id: null }] : [])].some((g) => g.id !== activeGroupId && groupHasFinished(g.id)) && (
              <span className="w-1.5 h-1.5 rounded-full term-tab-done-dot bg-yellow-400" />
            )}
            <ChevronDown size={14} />
          </button>
          {showGroupMenu && (
            <div className="absolute left-0 top-full mt-1 z-30 bg-surface-2 border border-border-subtle rounded-brand shadow-lg py-1 min-w-[160px]">
              {[...groups, ...(hasUngrouped ? [{ id: null, name: t("groups.ungrouped") }] : [])].map((g) => (
                <button
                  key={g.id || "ungrouped"}
                  onClick={() => { vibrate(); onSelectGroup(g.id); setShowGroupMenu(false); }}
                  className={`w-full text-left px-3 py-1.5 text-sm hover:bg-surface-3 flex items-center justify-between gap-2 ${g.id === activeGroupId ? "text-brand-500" : "text-text"}`}
                >
                  <span className="truncate">{g.name}</span>
                  {groupHasFinished(g.id) && <span className="w-1.5 h-1.5 rounded-full term-tab-done-dot bg-yellow-400 flex-shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* overflow-auto whitelists this for mobile touchmove (see page.js preventScroll) */}
      <div ref={tabsContainerRef} className="flex-1 overflow-auto overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-dark-400 scrollbar-track-transparent">
        <div className="flex gap-0.5 min-w-max items-center">
          {sessions.map((session) => {
            const isActiveTab = session.id === activeSessionId;
            const hasNotif = !!notifications[session.id];
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
                className={`px-2 py-1.5 text-sm font-medium transition-all duration-150 ease-out flex items-center gap-2 whitespace-nowrap ${
                  isActiveTab ? "border-brand-500 text-brand-500" : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${hasNotif ? "bg-yellow-400 term-tab-done-dot" : connected ? "bg-green-400" : "bg-red-400"}`} />
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
            <div className="relative sticky right-0 ml-1 flex-shrink-0">
              <button
                onClick={() => { vibrate(); setCreateModalOpen(true); }}
                disabled={!connected}
                className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text transition-all duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed rounded-brand"
                title={t("terminal.newTerminal")}
              >
                <Plus size={18} />
              </button>
            </div>
          )}
        </div>
      </div>

      {onOpenRemote && (
        <button
          onClick={() => { vibrate(); onOpenRemote(); }}
          className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
          title={t("menu.remoteDesktop")}
        >
          <Monitor size={18} />
        </button>
      )}

      <button
        onClick={() => { vibrate(); openMenu(); }}
        className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
        title={t("menu.title")}
      >
        <Settings size={18} />
      </button>

      {/* Tab right-click context menu */}
      {tabMenu.sessionId && (
        <div
          ref={tabMenuRef}
          className="fixed z-[60] bg-surface-2 border border-border-subtle rounded-brand shadow-lg py-1 min-w-[140px]"
          style={{ left: tabMenu.x, top: tabMenu.y }}
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
          suggestName={suggestTerminalName(activeGroupId)}
        />
      )}

      {/* Tab delete confirm */}
      {tabDeleteConfirm.isOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
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
    </div>
  );
}
