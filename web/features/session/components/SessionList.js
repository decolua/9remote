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
import { useSessionDragReorder } from "@/features/session/hooks/useSessionDragReorder";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { shortenHomePath } from "@/features/terminal/lib/workspaceGrouping";
import { useWorkspaceGit } from "@/features/terminal/hooks/useWorkspaceGit";
import BranchBadge from "@/features/terminal/components/BranchBadge";
import StatusBar, { statusTextCls } from "@/shared/components/ui/StatusBar";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";

const UNGROUPED_KEY = "ungrouped";

const PLATFORM_LABEL = { darwin: "mac", win32: "win", linux: "linux" };

// Path + branch beneath a workspace name, mirroring the desktop sidebar so the two views
// describe a workspace the same way.
function WorkspaceSubtitle({ path, fileSocket, homeDir }) {
  const { branch, dirty } = useWorkspaceGit(path, fileSocket);
  if (!path && !branch) return null;
  return (
    <span className="text-[11px] text-text-subtle truncate leading-tight flex items-center gap-1.5">
      {path && <span className="truncate">{shortenHomePath(path, homeDir)}</span>}
      <BranchBadge branch={branch} dirty={dirty} className="flex-shrink-0" />
    </span>
  );
}

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus, isActive = true, socketRef, subscribeToPush, unsubscribeFromPush, notifications = {}, sessionStatus = {}, clearNotification, agentVersion, updateAvailable = null, canSelfUpdate = false, onUpdate, onRestart, transport = "ws", platform, workspaces = [], onRenameWorkspace, onDeleteWorkspace, onReorderSession, onAddWorkspace, fileSocket, homeDir, shells = [] }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  const [sitesModalOpen, setSitesModalOpen] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState(null);
  const [editWorkspaceName, setEditWorkspaceName] = useState("");
  const [wsDeleteConfirm, setWsDeleteConfirm] = useState({ isOpen: false, workspaceId: null, workspaceName: "" });
  const [terminalModal, setTerminalModal] = useState({ open: false, workspaceId: null });

  // Pointer-based drag reorder (mobile-first) — see hooks/useSessionDragReorder.
  const DRAG_REORDER_ENABLED = false; // TEMP: off — long-press grip hijacks touch scroll on mobile
  const { drag, suppressClickRef, clearPress, onGripPointerDown, onCardPointerMove } =
    useSessionDragReorder({ connected, onReorderSession });

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
      onUpdate,
      onRestart,
    });
  }, [
    isActive,
    connected,
    onOpenRemote,
    onOpenFiles,
    codespaceInfo,
    onLogout,
    onStopCodespace,
    onUpdate,
    onRestart,
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

  const submitCreateTerminal = (name, shellId) => {
    onCreate?.(name, terminalModal.workspaceId, shellId);
    setTerminalModal({ open: false, workspaceId: null });
  };

  // Suggested name based on terminal count in target workspace
  const suggestTerminalName = (workspaceId) => {
    const count = sessions.filter((s) => sessionWorkspaceId(s) === workspaceId).length;
    return `${t("terminal.defaultName")} ${count + 1}`;
  };

  const handleSaveWorkspaceEdit = (workspaceId) => {
    if (editWorkspaceName.trim()) onRenameWorkspace?.(workspaceId, editWorkspaceName.trim());
    setEditingWorkspaceId(null);
    setEditWorkspaceName("");
  };

  const confirmWorkspaceDelete = () => {
    if (wsDeleteConfirm.workspaceId) onDeleteWorkspace?.(wsDeleteConfirm.workspaceId);
    setWsDeleteConfirm({ isOpen: false, workspaceId: null, workspaceName: "" });
  };

  // Build accordion sections: real workspaces (in order) + Unassigned last
  const sections = [
    ...workspaces.map((g) => ({ key: g.id, id: g.id, name: g.name, path: g.path || null, isUnassigned: false })),
    { key: UNGROUPED_KEY, id: null, name: t("workspaces.ungrouped"), isUnassigned: true }
  ];
  const sessionsByWorkspace = (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === workspaceId);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className={`bg-surface/80 backdrop-blur-md px-4 sm:px-6 py-3 sm:py-0 ${PANEL_HEADER_H_CLASS} flex items-center justify-between flex-shrink-0 border-b border-border-subtle`}>
        <div className="flex items-center gap-3">
          <div className="p-1.5 sm:p-1 bg-brand-500/10 rounded-brand">
            <Zap className="text-brand-500 w-5 h-5 sm:w-4 sm:h-4" />
          </div>
          <h1 className="text-text text-lg sm:text-sm font-semibold">{t("sessions.headerTitle")}</h1>
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
              className={`p-2 sm:p-1 rounded-brand transition-colors active:scale-[0.96] ${
                connected
                  ? "text-text-muted hover:text-text hover:bg-surface-2"
                  : "text-text-subtle cursor-not-allowed"
              }`}
              title={t("menu.remoteDesktop")}
            >
              <Monitor className="w-5 h-5 sm:w-4 sm:h-4" />
            </button>
          )}

          {/* Files Button */}
          <button
            onClick={() => { vibrate(); onOpenFiles(); }}
            disabled={!connected}
            className={`p-2 sm:p-1 rounded-brand transition-colors active:scale-[0.96] ${
              connected
                ? "text-text-muted hover:text-text hover:bg-surface-2"
                : "text-text-subtle cursor-not-allowed"
            }`}
            title={t("menu.files")}
          >
            <FolderOpen className="w-5 h-5 sm:w-4 sm:h-4" />
          </button>

          {/* Sites Button */}
          <button
            onClick={handleOpenSites}
            disabled={!connected}
            className={`p-2 sm:p-1 rounded-brand transition-colors active:scale-[0.96] ${
              connected
                ? "text-text-muted hover:text-text hover:bg-surface-2"
                : "text-text-subtle cursor-not-allowed"
            }`}
            title={t("menu.sites")}
          >
            <Globe className="w-5 h-5 sm:w-4 sm:h-4" />
          </button>

          {/* Menu Button */}
          <button
            onClick={() => { vibrate(); openMenu(); }}
            className="p-2 sm:p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors active:scale-[0.96]"
            title={t("menu.title")}
          >
            <Settings className="w-5 h-5 sm:w-4 sm:h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-auto modal-scrollable" style={{ overflowAnchor: "none" }}>
        {/* Agent outdated warning — only when connected (update is meaningless mid-connect) */}
        {connected && (isAgentOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || isWebOutdated(agentVersion, process.env.NEXT_PUBLIC_SERVER_VERSION) || updateAvailable) && (
          <AgentOutdatedBanner agentVersion={agentVersion} webVersion={process.env.NEXT_PUBLIC_SERVER_VERSION} updateAvailable={updateAvailable} canSelfUpdate={canSelfUpdate} onUpdate={onUpdate} className="mb-6" />
        )}
        {/* Sessions grouped by workspace — create via inline dashed cards */}
        {(
          <div className="space-y-8">
            {sections.map((section) => {
              const workspaceSessions = sessionsByWorkspace(section.id);
              // Hide the empty Unassigned bucket to reduce clutter
              if (section.isUnassigned && workspaceSessions.length === 0) return null;
              return (
                <div key={section.key}>
                  {/* Workspace header — folder icon, no collapse */}
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <div className="flex items-center gap-1.5 text-sm text-text-muted">
                      <Folder size={16} className="text-brand-500/70" />
                      {editingWorkspaceId === section.id ? (
                        <input
                          type="text"
                          value={editWorkspaceName}
                          onChange={(e) => setEditWorkspaceName(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSaveWorkspaceEdit(section.id); if (e.key === "Escape") setEditingWorkspaceId(null); }}
                          onBlur={() => handleSaveWorkspaceEdit(section.id)}
                          className="bg-surface-2 text-text px-2 py-0.5 rounded-brand focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                          autoFocus
                        />
                      ) : (
                        <span className="flex flex-col min-w-0">
                          <span className="font-medium text-text truncate">{section.name}</span>
                          <WorkspaceSubtitle
                            path={section.path || workspaceSessions.find((s) => s.workspacePath)?.workspacePath}
                            fileSocket={fileSocket}
                            homeDir={homeDir}
                          />
                        </span>
                      )}
                      <span className="text-xs text-text-muted flex-shrink-0">({workspaceSessions.length})</span>
                    </div>
                    {!section.isUnassigned && (
                      <>
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { vibrate(); setEditingWorkspaceId(section.id); setEditWorkspaceName(section.name); }}
                          className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
                          title={t("workspaces.rename")}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => { vibrate(); setWsDeleteConfirm({ isOpen: true, workspaceId: section.id, workspaceName: section.name }); }}
                          className="p-1 rounded-brand text-text-muted hover:text-red-400 hover:bg-red-500/15 transition-colors"
                          title={t("workspaces.delete")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                    {/* Add terminal button — mobile only, pinned right */}
                    <button
                      onClick={() => { vibrate(); setTerminalModal({ open: true, workspaceId: section.id }); }}
                      disabled={!connected}
                      className={`sm:hidden ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-brand-500 transition-colors active:scale-[0.97] ${connected ? "hover:bg-brand-500/15" : "opacity-50 cursor-not-allowed"}`}
                      title={t("workspaces.addTerminal")}
                    >
                      <Plus size={14} /> Term
                    </button>
                  </div>

                  {/* Cards */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {workspaceSessions.map((session, cardIdx) => {
                          const isDragging = drag?.workspaceId === section.id && drag.fromIdx === cardIdx;
                          const isDragOver = drag?.workspaceId === section.id && drag.overIdx === cardIdx && drag.fromIdx !== cardIdx;
                          const workspaceIds = workspaceSessions.map((s) => s.id);
                          const dotBase = connected ? "" : "opacity-40 saturate-0";
                          const draggable = DRAG_REORDER_ENABLED && connected && workspaceSessions.length > 1;
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
                              className={`rounded-xl overflow-hidden border ring-1 term-card ${v.cls} status-border-${st}${isDragOver ? " ring-2 ring-brand-500/50" : ""}`}
                              style={{ background: connected ? "var(--card-term-bg)" : "var(--card-term-bg-off)", borderColor: "var(--card-border)", boxShadow: "var(--card-shadow)", ["--tw-ring-color"]: "var(--card-ring)" }}
                            >
                              <div>
                                {/* Titlebar — drag handle for mobile reorder (long-press to drag) */}
                                <div
                                  onPointerDown={draggable ? (e) => onGripPointerDown(e, section.id, workspaceIds, cardIdx) : undefined}
                                  onPointerUp={draggable ? clearPress : undefined}
                                  onPointerLeave={draggable ? clearPress : undefined}
                                  onPointerMove={draggable ? onCardPointerMove : undefined}
                                  className={`flex items-center gap-2 px-2.5 py-1.5 border-b ${draggable ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
                                  style={{ background: "var(--card-titlebar-bg)", borderColor: "var(--card-titlebar-border)" }}
                                >
                                  <div className={`flex items-center gap-1.5 flex-shrink-0 ${dotBase}`}>
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#ff5f57]" />
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#febc2e]" />
                                    <span className="w-[10px] h-[10px] rounded-full bg-[#28c840]" />
                                  </div>
                                  <span className="flex-1 min-w-0 text-center text-[11px] font-medium truncate" style={{ color: "var(--card-name-fg)" }}>
                                    {session.name}
                                  </span>
                                  <div className="flex items-center gap-2 flex-shrink-0" onPointerDown={(e) => e.stopPropagation()}>
                                    <button
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={(e) => { e.stopPropagation(); vibrate(); handleStartEdit(session); }}
                                      disabled={!connected}
                                      className={`p-1.5 rounded-md transition-colors ${connected ? "hover:bg-amber-500/10" : "cursor-not-allowed"}`}
                                      style={{ color: connected ? "var(--card-accent-amber)" : "var(--card-btn-disabled)" }}
                                      title={t("sessions.editName")}
                                    >
                                      <Pencil size={16} />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); vibrate(); handleDeleteWithConfirm(session.id, session.name); }}
                                      disabled={!connected}
                                      className={`p-1.5 rounded-md transition-colors ${connected ? "hover:bg-red-500/15" : "cursor-not-allowed"}`}
                                      style={{ color: connected ? "var(--card-accent-red)" : "var(--card-btn-disabled)" }}
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
                                      className="w-full text-[12px] px-2 py-1 rounded focus:outline-none focus:ring-2 focus:ring-brand-500/50"
                                      style={{ background: "var(--card-input-bg)", color: "var(--card-input-fg)" }}
                                      autoFocus
                                    />
                                  ) : (
                                    <div className="text-[11.5px] leading-[1.7] space-y-0.5">
                                      <div className="flex items-center min-w-0">
                                        <span className="flex-shrink-0" style={{ color: "var(--card-accent-green)" }}>➜</span>
                                        <span className="flex-shrink-0 mx-1" style={{ color: "var(--card-accent-cyan)" }}>~</span>
                                        <span className="truncate" style={{ color: "var(--card-body-fg)" }}>{session.name}</span>
                                      </div>
                                      {connected ? (
                                        <>
                                          <div className="truncate" style={{ color: "var(--card-body-dim)" }}>
                                            <span style={{ color: "var(--card-accent-green)" }}>✓</span> connected
                                          </div>
                                          <div className="truncate" style={{ color: "var(--card-body-dim)" }}>
                                            <span style={{ color: "var(--card-accent-amber)" }}>●</span> {t("sessions.created", { time: new Date(session.createdAt).toLocaleTimeString(undefined, { hour12: false }) })}
                                          </div>
                                        </>
                                      ) : (
                                        <div className="truncate" style={{ color: "var(--card-body-dim)", opacity: 0.7 }}>
                                          <span style={{ color: "var(--card-accent-red)" }}>✕</span> disconnected
                                        </div>
                                      )}
                                      <div className="flex items-center min-w-0">
                                        <span className="flex-shrink-0" style={{ color: "var(--card-accent-green)" }}>➜</span>
                                        <span className="flex-shrink-0 mx-1" style={{ color: "var(--card-accent-cyan)" }}>~</span>
                                        <span className="inline-block flex-shrink-0 w-[7px] h-[14px] animate-pulse" style={{ background: "var(--card-accent-green)", opacity: 0.8 }} />
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                          );
                        })}
                        {/* Inline dashed card to add a terminal — desktop only; hidden on mobile when the workspace has terminals */}
                        <button
                          onClick={() => { vibrate(); setTerminalModal({ open: true, workspaceId: section.id }); }}
                          disabled={!connected}
                          className={`min-h-[164px] rounded-xl p-3 items-center justify-center gap-1.5 text-sm border border-dashed border-brand-500/40 bg-brand-500/5 text-text-muted transition-all duration-150 ease-out ${workspaceSessions.length > 0 ? "hidden sm:flex" : "flex"} ${connected ? "hover:border-brand-500 hover:text-brand-500 hover:bg-brand-500/10 hover:-translate-y-1" : "opacity-50 cursor-not-allowed"}`}
                          title={t("workspaces.addTerminal")}
                        >
                          <Plus className="text-brand-500" size={16} /> <span className="text-brand-500">{t("terminal.newTerminal")}</span>
                        </button>
                      </div>
                </div>
              );
            })}

            {/* Action to create a new workspace (opens the folder picker) */}
            <button
              onClick={() => { vibrate(); onAddWorkspace?.(); }}
              disabled={!connected}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-dashed border-brand-500/50 text-brand-500 bg-brand-500/5 transition-all duration-150 ease-out active:scale-[0.97] ${connected ? "hover:bg-brand-500/15 hover:border-brand-500" : "opacity-50 cursor-not-allowed"}`}
            >
              <FolderPlus size={16} /> {t("workspaces.newWorkspace")}
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

      {/* Delete Group Confirm Dialog */}
      <ConfirmDialog
        isOpen={wsDeleteConfirm.isOpen}
        onClose={() => setWsDeleteConfirm({ isOpen: false, workspaceId: null, workspaceName: "" })}
        onConfirm={confirmWorkspaceDelete}
        title={t("workspaces.deleteTitle")}
        message={t("workspaces.deleteMessage", { name: wsDeleteConfirm.workspaceName })}
      />

      {/* Create Terminal Modal (shared) */}
      {terminalModal.open && (
        <NewTerminalModal
          onClose={() => setTerminalModal({ open: false, workspaceId: null })}
          onCreate={submitCreateTerminal}
          shells={shells}
          suggestName={suggestTerminalName(terminalModal.workspaceId)}
        />
      )}

      {/* Sites Modal - Reuse SitesList component */}
      <SitesList
        tunnelUrl={tunnelUrl}
        apiKey={apiKey}
        isOpen={sitesModalOpen}
        onClose={handleCloseSitesModal}
      />

      {/* Same status bar as the terminal view — switching between them must not change
          the chrome under the content. */}
      <StatusBar
        className="hidden sm:flex"
        left={<>
          <span className={statusTextCls}>
            <Terminal size={12} className="opacity-60" />
            {t("sessions.headerTitle")}
          </span>
          <span className={statusTextCls}>
            {sessions.length} {t("workspaces.title").toLowerCase()}
          </span>
        </>}
        right={<>
          {platform && <span className={statusTextCls}>{PLATFORM_LABEL[platform] || platform}</span>}
          {agentVersion && <span className={`${statusTextCls} text-text-subtle`}>v{agentVersion}</span>}
          <span className={statusTextCls}>
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
            <span className="uppercase tracking-wide">{transport}</span>
          </span>
        </>}
      />
    </div>
  );
}
