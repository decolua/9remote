"use client";

import { useState, useEffect, useRef } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import NewTerminalModal from "@/shared/components/ui/NewTerminalModal";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import SitesList from "@/features/terminal/components/SitesList";
import { Terminal, Pencil, Trash2, Settings, Monitor, FolderOpen, Globe, Zap, Plus, FolderPlus, X, Folder } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { statusVisual } from "@/shared/utils/statusVisual";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";

const UNGROUPED_KEY = "ungrouped";

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus, isActive = true, socketRef, subscribeToPush, unsubscribeFromPush, notifications = {}, sessionStatus = {}, clearNotification, agentVersion, updateAvailable = null, canSelfUpdate = false, onUpdate, transport = "ws", groups = [], onCreateGroup, onRenameGroup, onDeleteGroup, onReorderSession, shells = [] }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  const [sitesModalOpen, setSitesModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupName, setEditGroupName] = useState("");
  const [groupDeleteConfirm, setGroupDeleteConfirm] = useState({ isOpen: false, groupId: null, groupName: "" });
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [terminalModal, setTerminalModal] = useState({ open: false, groupId: null });

  // Pointer-based drag reorder (mobile-first). Long-press activates drag; card follows pointer.
  const [drag, setDrag] = useState(null); // { groupId, fromIdx, overIdx }
  const dragRef = useRef(null);
  const pressTimer = useRef(null);
  const pressStartRef = useRef(null);
  const suppressClickRef = useRef(false);

  const clearPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };

  const resetCard = (el) => {
    if (!el) return;
    el.style.transform = "";
    el.style.zIndex = "";
    el.style.transition = "";
    el.style.willChange = "";
  };

  const startDrag = (e, groupId, ids, fromIdx, cardEl) => {
    vibrate();
    dragRef.current = { groupId, ids, fromIdx, overIdx: fromIdx, startX: e.clientX, startY: e.clientY, cardEl, moved: false };
    setDrag({ groupId, fromIdx, overIdx: fromIdx });
    try { cardEl.setPointerCapture(e.pointerId); } catch {}
  };

  const onGripPointerDown = (e, groupId, ids, fromIdx) => {
    if (!connected || ids.length < 2) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    clearPress();
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    const cardEl = e.currentTarget;
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      startDrag(e, groupId, ids, fromIdx, cardEl);
    }, 180);
  };

  // Cancel pending long-press if the finger moves (likely scrolling) during hold
  const onCardPointerMove = (e) => {
    if (!pressTimer.current || !pressStartRef.current) return;
    if (Math.abs(e.clientX - pressStartRef.current.x) > 8 || Math.abs(e.clientY - pressStartRef.current.y) > 8) clearPress();
  };

  useEffect(() => {
    if (!drag) return;
    const findIdx = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest("[data-session-card]");
      if (!el) return null;
      const i = Number(el.getAttribute("data-card-idx"));
      return Number.isNaN(i) ? null : i;
    };
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault(); // block touch scroll during active drag
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
      if (d.moved) {
        // Drive the card straight to the DOM (60fps, no React re-render per move)
        d.cardEl.style.transition = "none";
        d.cardEl.style.willChange = "transform";
        d.cardEl.style.zIndex = "50";
        d.cardEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.05) rotate(2deg)`;
      }
      const i = findIdx(e.clientX, e.clientY);
      if (i != null && i !== d.overIdx) {
        d.overIdx = i;
        setDrag({ ...drag, overIdx: i });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d) {
        // Drag was activated (long-press timer fired) → swallow the synthesized click that follows,
        // even if the finger barely moved. Without this, a long-press-and-release (no reorder)
        // still opens the terminal.
        suppressClickRef.current = true;
        resetCard(d.cardEl);
        if (d.fromIdx !== d.overIdx) {
          const ids = [...d.ids];
          const [moved] = ids.splice(d.fromIdx, 1);
          ids.splice(d.overIdx, 0, moved);
          onReorderSession?.(ids);
          vibrate();
        }
      }
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, onReorderSession]);

  // Slide menu store
  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

  // Set up menu context and callbacks - only when active
  useEffect(() => {
    if (!isActive) return;
    
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: false,
      theme: "default",
      socketRef,
      hideActions: ['remote', 'files', 'sites', 'terminalSettings'],
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      notifications,
      clearNotification,
      agentVersion,
      transport,
    });

    setCallbacks({
      onRemote: null, // Handled by header buttons
      onFiles: null, // Handled by header buttons
      onSites: null, // Handled by header buttons
      onSelectSite: null,
      onRefreshSites: null,
      onCodespace: null,
      onLogout,
      onThemeChange: null,
      onStopCodespace,
    });
  }, [
    isActive,
    connected, 
    onOpenRemote, 
    onOpenFiles, 
    codespaceInfo, 
    onLogout, 
    onStopCodespace,
    setContext,
    setCallbacks,
    socketRef,
    connectionMode,
    subscribeToPush,
    unsubscribeFromPush,
    agentVersion,
    transport
  ]);

  const handleStartEdit = (session) => {
    setEditingId(session.id);
    setEditName(session.name);
  };

  const handleSaveEdit = async (sessionId) => {
    if (!editName.trim()) return;
    await onRename(sessionId, editName.trim());
    setEditingId(null);
    setEditName("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  const handleDeleteWithConfirm = (sessionId, sessionName) => {
    setDeleteConfirm({ isOpen: true, sessionId, sessionName });
  };

  const closeDeleteConfirm = () => {
    setDeleteConfirm({ isOpen: false, sessionId: null, sessionName: "" });
  };

  const confirmDelete = () => {
    if (deleteConfirm.sessionId) {
      onDelete(deleteConfirm.sessionId);
    }
    closeDeleteConfirm();
  };

  const handleOpenSites = () => {
    vibrate();
    setSitesModalOpen(true);
  };

  const handleCloseSitesModal = () => {
    setSitesModalOpen(false);
  };

  // Group helpers — create group via modal, then auto-create one terminal inside it
  const submitCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateGroup?.(name, (result) => {
      if (result?.success && result.group?.id) onCreate(null, result.group.id);
    });
    setNewGroupName("");
    setGroupModalOpen(false);
  };

  const submitCreateTerminal = (name, shellId) => {
    onCreate?.(name, terminalModal.groupId, shellId);
    setTerminalModal({ open: false, groupId: null });
  };

  // Suggested name based on terminal count in target group
  const suggestTerminalName = (groupId) => {
    const count = sessions.filter((s) => (s.groupId || null) === groupId).length;
    return `${t("terminal.defaultName")} ${count + 1}`;
  };

  const handleSaveGroupEdit = (groupId) => {
    if (editGroupName.trim()) onRenameGroup?.(groupId, editGroupName.trim());
    setEditingGroupId(null);
    setEditGroupName("");
  };

  const confirmGroupDelete = () => {
    if (groupDeleteConfirm.groupId) onDeleteGroup?.(groupDeleteConfirm.groupId);
    setGroupDeleteConfirm({ isOpen: false, groupId: null, groupName: "" });
  };

  // Build accordion sections: real groups (in order) + Ungrouped last
  const sections = [
    ...groups.map((g) => ({ key: g.id, id: g.id, name: g.name, isUngrouped: false })),
    { key: UNGROUPED_KEY, id: null, name: t("groups.ungrouped"), isUngrouped: true }
  ];
  const sessionsByGroup = (groupId) => sessions.filter((s) => (s.groupId || null) === groupId);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface/80 backdrop-blur-md px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-brand-500/10 rounded-brand">
            <Zap className="text-brand-500" size={20} />
          </div>
          <h1 className="text-text text-lg font-semibold">{t("sessions.headerTitle")}</h1>
          {/* Connection indicator */}
          <span 
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
            title={connected ? t("sessions.connected") : t("sessions.disconnected")}
          />
          {!connected && codespaceDisconnected && (
            <span className="text-red-400 text-xs">{t("sessions.codespaceStopped")}</span>
          )}
        </div>
        
        {/* Action Buttons */}
        <div className="flex items-center gap-1">
          {/* Remote Button */}
          {onOpenRemote && (
            <button
              onClick={() => { vibrate(); onOpenRemote(); }}
              disabled={!connected}
              className={`p-2 rounded-brand transition-colors active:scale-[0.96] ${
                connected
                  ? "text-text-muted hover:text-text hover:bg-surface-2"
                  : "text-text-subtle cursor-not-allowed"
              }`}
              title={t("menu.remoteDesktop")}
            >
              <Monitor size={20} />
            </button>
          )}

          {/* Files Button */}
          <button
            onClick={() => { vibrate(); onOpenFiles(); }}
            disabled={!connected}
            className={`p-2 rounded-brand transition-colors active:scale-[0.96] ${
              connected
                ? "text-text-muted hover:text-text hover:bg-surface-2"
                : "text-text-subtle cursor-not-allowed"
            }`}
            title={t("menu.files")}
          >
            <FolderOpen size={20} />
          </button>

          {/* Sites Button */}
          <button
            onClick={handleOpenSites}
            disabled={!connected}
            className={`p-2 rounded-brand transition-colors active:scale-[0.96] ${
              connected
                ? "text-text-muted hover:text-text hover:bg-surface-2"
                : "text-text-subtle cursor-not-allowed"
            }`}
            title={t("menu.sites")}
          >
            <Globe size={20} />
          </button>

          {/* Menu Button */}
          <button
            onClick={() => { vibrate(); openMenu(); }}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors active:scale-[0.96]"
            title={t("menu.title")}
          >
            <Settings size={20} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-auto modal-scrollable" style={{ overflowAnchor: "none" }}>
        {/* Agent outdated warning — only when connected (update is meaningless mid-connect) */}
        {connected && (isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || isWebOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || updateAvailable) && (
          <AgentOutdatedBanner agentVersion={agentVersion} webVersion={process.env.NEXT_PUBLIC_SERVER_VERSION} updateAvailable={updateAvailable} canSelfUpdate={canSelfUpdate} onUpdate={onUpdate} className="mb-6" />
        )}
        {/* Sessions grouped accordion — create via inline dashed cards */}
        {(
          <div className="space-y-8">
            {sections.map((section) => {
              const groupSessions = sessionsByGroup(section.id);
              // Hide empty Ungrouped to reduce clutter
              if (section.isUngrouped && groupSessions.length === 0) return null;
              return (
                <div key={section.key}>
                  {/* Group header — folder icon, no collapse */}
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <div className="flex items-center gap-1.5 text-sm text-text-muted">
                      <Folder size={16} className="text-brand-500/70" />
                      {editingGroupId === section.id ? (
                        <input
                          type="text"
                          value={editGroupName}
                          onChange={(e) => setEditGroupName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSaveGroupEdit(section.id); if (e.key === "Escape") setEditingGroupId(null); }}
                          onBlur={() => handleSaveGroupEdit(section.id)}
                          className="bg-surface-2 text-text px-2 py-0.5 rounded-brand focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                          autoFocus
                        />
                      ) : (
                        <span className="font-medium text-text">{section.name}</span>
                      )}
                      <span className="text-xs text-text-muted">({groupSessions.length})</span>
                    </div>
                    {!section.isUngrouped && (
                      <>
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { vibrate(); setEditingGroupId(section.id); setEditGroupName(section.name); }}
                          className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
                          title={t("groups.rename")}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => { vibrate(); setGroupDeleteConfirm({ isOpen: true, groupId: section.id, groupName: section.name }); }}
                          className="p-1 rounded-brand text-text-muted hover:text-red-400 hover:bg-red-500/15 transition-colors"
                          title={t("groups.delete")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Cards */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {groupSessions.map((session, cardIdx) => {
                          const isDragging = drag?.groupId === section.id && drag.fromIdx === cardIdx;
                          const isDragOver = drag?.groupId === section.id && drag.overIdx === cardIdx && drag.fromIdx !== cardIdx;
                          const groupIds = groupSessions.map((s) => s.id);
                          const dotBase = connected ? "" : "opacity-40 saturate-0";
                          const draggable = connected && groupSessions.length > 1;
                          const st = sessionStatus[session.id]?.state || "idle";
                          const v = statusVisual(st);
                          return (
                          <div
                            key={session.id}
                            data-session-card
                            data-card-idx={cardIdx}
                            onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } if (!drag && connected) { vibrate(); onSelect(session.id); } }}
                            className={`group relative select-none rounded-xl transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${isDragOver ? "scale-[1.02] ring-2 ring-brand-500" : ""} ${connected && !drag ? "hover:-translate-y-1" : ""} ${!connected ? "opacity-60" : ""}`}
                          >
                            {/* Terminal window */}
                            <div
                              className={`rounded-xl overflow-hidden border border-text-muted/25 ring-1 ring-text-muted/10 shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_8px_28px_-6px_rgba(0,0,0,0.7)] term-card ${v.cls} status-border-${st}${isDragOver ? " ring-2 ring-brand-500/50" : ""}`}
                              style={{ background: connected ? "linear-gradient(155deg,#1c1d1f 0%,#151617 55%,#0f1011 100%)" : "linear-gradient(155deg,#161719,#0e0f10)" }}
                            >
                              <div>
                                {/* Titlebar — drag handle for mobile reorder (long-press to drag) */}
                                <div
                                  onPointerDown={draggable ? (e) => onGripPointerDown(e, section.id, groupIds, cardIdx) : undefined}
                                  onPointerUp={draggable ? clearPress : undefined}
                                  onPointerLeave={draggable ? clearPress : undefined}
                                  onPointerMove={draggable ? onCardPointerMove : undefined}
                                  className={`flex items-center gap-2 px-2.5 py-1.5 bg-[#2c2c2e]/90 border-b border-black/30 ${draggable ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
                                >
                                  <div className={`flex items-center gap-1.5 flex-shrink-0 ${dotBase}`}>
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#ff5f57]" />
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#febc2e]" />
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#28c840]" />
                                  </div>
                                  <span className="flex-1 min-w-0 text-center text-[11px] font-medium text-white/55 truncate">
                                    {session.name}
                                  </span>
                                  <div className="flex items-center gap-2 flex-shrink-0" onPointerDown={(e) => e.stopPropagation()}>
                                    <button
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={(e) => { e.stopPropagation(); vibrate(); handleStartEdit(session); }}
                                      disabled={!connected}
                                      className={`p-1.5 rounded-md transition-colors ${connected ? "text-amber-400/70 hover:text-amber-300 hover:bg-amber-400/15" : "text-white/20 cursor-not-allowed"}`}
                                      title={t("sessions.editName")}
                                    >
                                      <Pencil size={16} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); vibrate(); handleDeleteWithConfirm(session.id, session.name); }}
                                      disabled={!connected}
                                      className={`p-1.5 rounded-md transition-colors ${connected ? "text-red-400/70 hover:text-red-300 hover:bg-red-500/20" : "text-white/20 cursor-not-allowed"}`}
                                      title={t("common.delete")}
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  </div>
                                </div>

                                {/* Body — fake terminal */}
                                <div
                                  className={`relative px-3 py-3 font-mono min-h-[128px] ${connected && editingId !== session.id && !drag ? "cursor-pointer" : "cursor-default"}`}
                                  onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } if (connected && editingId !== session.id && !drag) { vibrate(); onSelect(session.id); } }}
                                >
                                  {/* Status badge — top-right of body, mirrors tab dot */}
                                  {st !== "idle" && (
                                    <span
                                      className={`absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${v.cls}`}
                                      style={{ background: `${v.dot}22`, color: v.dot }}
                                    >
                                      <span className={`w-1.5 h-1.5 rounded-full term-dot${v.pulse ? ` pulse-${v.pulse}` : ""}`} style={{ background: v.dot }} />
                                      {t(v.label)}
                                    </span>
                                  )}
                                  {editingId === session.id ? (
                                    <input
                                      type="text"
                                      value={editName}
                                      onChange={(e) => setEditName(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") handleSaveEdit(session.id);
                                        if (e.key === "Escape") handleCancelEdit();
                                      }}
                                      onBlur={() => handleSaveEdit(session.id)}
                                      onClick={(e) => e.stopPropagation()}
                                      className="w-full bg-black/40 text-white text-[12px] px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                                      autoFocus
                                    />
                                  ) : (
                                    <div className="text-[11.5px] leading-[1.7] space-y-0.5">
                                      <div className="flex items-center min-w-0">
                                        <span className="text-emerald-400 flex-shrink-0">➜</span>
                                        <span className="text-cyan-400 flex-shrink-0 mx-1">~</span>
                                        <span className="text-white/45 truncate">{session.name}</span>
                                      </div>
                                      {connected ? (
                                        <>
                                          <div className="text-white/35 truncate">
                                            <span className="text-emerald-400">✓</span> connected
                                          </div>
                                          <div className="text-white/35 truncate">
                                            <span className="text-amber-400">●</span> {t("sessions.created", { time: new Date(session.createdAt).toLocaleTimeString() })}
                                          </div>
                                        </>
                                      ) : (
                                        <div className="text-white/30 truncate">
                                          <span className="text-red-400/70">✕</span> disconnected
                                        </div>
                                      )}
                                      <div className="flex items-center min-w-0">
                                        <span className="text-emerald-400 flex-shrink-0">➜</span>
                                        <span className="text-cyan-400 flex-shrink-0 mx-1">~</span>
                                        <span className="inline-block flex-shrink-0 w-[7px] h-[14px] bg-emerald-400/80 animate-pulse" />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                          );
                        })}
                        {/* Inline dashed card to add a terminal into this group */}
                        <button
                          onClick={() => { vibrate(); setTerminalModal({ open: true, groupId: section.id }); }}
                          disabled={!connected}
                          className={`min-h-[164px] rounded-xl p-3 flex items-center justify-center gap-1.5 text-sm border border-dashed border-brand-500/40 bg-brand-500/5 text-text-muted transition-all duration-150 ease-out ${connected ? "hover:border-brand-500 hover:text-brand-500 hover:bg-brand-500/10 hover:-translate-y-1" : "opacity-50 cursor-not-allowed"}`}
                          title={t("groups.addTerminal")}
                        >
                          <Plus className="text-brand-500" size={16} /> <span className="text-brand-500">{t("terminal.newTerminal")}</span>
                        </button>
                      </div>
                </div>
              );
            })}

            {/* Action to create a new group (opens modal) */}
            <button
              onClick={() => { vibrate(); setGroupModalOpen(true); }}
              disabled={!connected}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-dashed border-brand-500/50 text-brand-500 bg-brand-500/5 transition-all duration-150 ease-out active:scale-[0.97] ${connected ? "hover:bg-brand-500/15 hover:border-brand-500" : "opacity-50 cursor-not-allowed"}`}
            >
              <FolderPlus size={16} /> {t("groups.newGroup")}
            </button>
          </div>
        )}
      </div>

      {/* Delete Session Confirm Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        onClose={closeDeleteConfirm}
        onConfirm={confirmDelete}
        title={t("sessions.deleteTitle")}
        message={t("sessions.deleteMessage", { name: deleteConfirm.sessionName })}
      />

      {/* Create Group Modal */}
      {groupModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setGroupModalOpen(false)} />
          <div className="relative card-elev max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-text mb-4">{t("groups.newGroup")}</h3>
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCreateGroup(); if (e.key === "Escape") setGroupModalOpen(false); }}
              placeholder={t("groups.newGroupPrompt")}
              autoFocus
            />
            <div className="flex gap-3 mt-5">
              <Button variant="primary" onClick={submitCreateGroup} disabled={!newGroupName.trim()} className="flex-1">{t("common.confirm")}</Button>
              <Button variant="secondary" onClick={() => { setNewGroupName(""); setGroupModalOpen(false); }} className="flex-1">{t("common.cancel")}</Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Group Confirm Dialog */}
      <ConfirmDialog
        isOpen={groupDeleteConfirm.isOpen}
        onClose={() => setGroupDeleteConfirm({ isOpen: false, groupId: null, groupName: "" })}
        onConfirm={confirmGroupDelete}
        title={t("groups.deleteTitle")}
        message={t("groups.deleteMessage", { name: groupDeleteConfirm.groupName })}
      />

      {/* Create Terminal Modal (shared) */}
      {terminalModal.open && (
        <NewTerminalModal
          onClose={() => setTerminalModal({ open: false, groupId: null })}
          onCreate={submitCreateTerminal}
          shells={shells}
          suggestName={suggestTerminalName(terminalModal.groupId)}
        />
      )}

      {/* Sites Modal - Reuse SitesList component */}
      <SitesList
        tunnelUrl={tunnelUrl}
        apiKey={apiKey}
        isOpen={sitesModalOpen}
        onClose={handleCloseSitesModal}
      />
    </div>
  );
}
