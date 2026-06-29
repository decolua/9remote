"use client";

import { useState, useEffect } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import SitesList from "@/features/terminal/components/SitesList";
import { Terminal, Pencil, Trash2, Settings, Monitor, FolderOpen, Globe, Zap, Plus, FolderPlus, X, Folder } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

const UNGROUPED_KEY = "ungrouped";

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus, isActive = true, socketRef, subscribeToPush, unsubscribeFromPush, notifications = {}, clearNotification, agentVersion, transport = "ws", groups = [], onCreateGroup, onRenameGroup, onDeleteGroup }) {
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
  const [newTerminalName, setNewTerminalName] = useState("");

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
      hideActions: ['remote', 'files', 'sites'],
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

  const submitCreateTerminal = () => {
    const name = newTerminalName.trim() || null;
    onCreate?.(name, terminalModal.groupId);
    setNewTerminalName("");
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
      <div className="flex-1 p-4 sm:p-6 overflow-auto modal-scrollable">
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {groupSessions.map((session) => (
                          <div
                            key={session.id}
                            className={`relative bg-surface border border-border-subtle rounded-brand-lg p-3 flex items-center justify-between transition-all duration-150 ease-out ${
                              connected ? "hover:bg-surface-2" : "opacity-50"
                            }`}
                          >
                            <div
                              className={`flex-1 flex items-center gap-3 ${connected && editingId !== session.id ? "cursor-pointer" : "cursor-default"}`}
                              onClick={() => { if (connected && editingId !== session.id) { vibrate(); onSelect(session.id); } }}
                            >
                              <div className="p-2 bg-brand-500/10 rounded-brand flex-shrink-0">
                                <Terminal className="text-brand-500" size={20} />
                              </div>
                              <div className="flex-1 min-w-0">
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
                                    className="w-full bg-surface-2 text-text px-2 py-1 rounded-brand focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
                                    autoFocus
                                  />
                                ) : (
                                  <>
                                    <h3 className="text-text font-medium truncate">{session.name}</h3>
                                    <p className="text-text-muted text-sm">
                                      {t("sessions.created", { time: new Date(session.createdAt).toLocaleTimeString() })}
                                    </p>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1.5 ml-3">
                              <button
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { vibrate(); handleStartEdit(session); }}
                                disabled={!connected}
                                className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.96] ${connected ? "hover:bg-surface-3 text-text-muted hover:text-text" : "text-text-muted cursor-not-allowed"}`}
                                title={t("sessions.editName")}
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                onClick={() => { vibrate(); handleDeleteWithConfirm(session.id, session.name); }}
                                disabled={!connected}
                                className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.96] ${connected ? "hover:bg-red-500/15 text-text-muted hover:text-red-400" : "text-text-muted cursor-not-allowed"}`}
                                title={t("common.delete")}
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                        {/* Inline dashed card to add a terminal into this group */}
                        <button
                          onClick={() => { vibrate(); setNewTerminalName(suggestTerminalName(section.id)); setTerminalModal({ open: true, groupId: section.id }); }}
                          disabled={!connected}
                          className={`min-h-[58px] rounded-brand-lg p-3 flex items-center justify-center gap-1.5 text-sm border border-dashed border-border text-text-muted transition-all duration-150 ease-out ${connected ? "hover:border-brand-500 hover:text-brand-500 hover:bg-brand-500/10" : "opacity-50 cursor-not-allowed"}`}
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

      {/* Create Terminal Modal */}
      {terminalModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setTerminalModal({ open: false, groupId: null })} />
          <div className="relative card-elev max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-text mb-4">{t("terminal.newTerminal")}</h3>
            <div className="relative">
              <Input
                value={newTerminalName}
                onChange={(e) => setNewTerminalName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCreateTerminal(); if (e.key === "Escape") setTerminalModal({ open: false, groupId: null }); }}
                placeholder={suggestTerminalName(terminalModal.groupId)}
                autoFocus
              />
              {newTerminalName && (
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setNewTerminalName("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text rounded-full hover:bg-surface-3 transition-colors"
                  aria-label="Clear"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <Button variant="primary" onClick={submitCreateTerminal} className="flex-1">{t("common.confirm")}</Button>
              <Button variant="secondary" onClick={() => { setNewTerminalName(""); setTerminalModal({ open: false, groupId: null }); }} className="flex-1">{t("common.cancel")}</Button>
            </div>
          </div>
        </div>
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
