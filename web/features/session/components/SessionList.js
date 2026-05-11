"use client";

import { useState, useEffect, useCallback } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import SitesList from "@/features/terminal/components/SitesList";
import { Terminal, Pencil, Trash2, Settings, Monitor, FolderOpen, Globe, Zap } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, connectionMode = "tunnel", codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus, isActive = true, socketRef, subscribeToPush, unsubscribeFromPush, notifications = {}, clearNotification, agentVersion, transport = "ws" }) {
  const { t } = useI18n();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });
  const [sitesModalOpen, setSitesModalOpen] = useState(false);

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

  const handleCreate = async () => {
    if (creating || !connected) return;
    setCreating(true);
    await onCreate(newName || `${t("terminal.defaultName")} ${sessions.length + 1}`);
    setNewName("");
    setCreating(false);
  };

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
        {/* Create new session */}
        <div className="mb-6 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder={t("sessions.placeholder")}
            disabled={!connected}
          />
          <Button
            variant="primary"
            onClick={() => { vibrate(); handleCreate(); }}
            disabled={creating || !connected}
            loading={creating}
            className="whitespace-nowrap"
          >
            {t("sessions.newButton")}
          </Button>
        </div>

        {/* Sessions list */}
        {sessions.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex p-4 bg-surface rounded-brand-lg mb-4">
              <Terminal className="text-text-muted" size={48} />
            </div>
            <p className="text-text mb-2 font-medium">{t("sessions.empty")}</p>
            <p className="text-text-muted text-sm">{t("sessions.emptyHint")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`bg-surface border border-border-subtle rounded-brand-lg p-3 flex items-center justify-between transition-all duration-150 ease-out ${
                  connected ? "hover:bg-surface-2" : "opacity-50"
                }`}
              >
                <div 
                  className={`flex-1 flex items-center gap-3 ${connected && editingId !== session.id ? "cursor-pointer" : "cursor-default"}`}
                  onClick={() => { if (connected && editingId !== session.id) { vibrate(); onSelect(session.id); } }}
                >
                  {/* Terminal Icon */}
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
                  {/* Edit Button */}
                  <button
                    onClick={() => { vibrate(); handleStartEdit(session); }}
                    disabled={!connected}
                    className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.96] ${
                      connected 
                        ? "hover:bg-surface-3 text-text-muted hover:text-text" 
                        : "text-text-muted cursor-not-allowed"
                    }`}
                    title={t("sessions.editName")}
                  >
                    <Pencil size={16} />
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => { vibrate(); handleDeleteWithConfirm(session.id, session.name); }}
                    disabled={!connected}
                    className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.96] ${
                      connected 
                        ? "hover:bg-red-500/15 text-text-muted hover:text-red-400" 
                        : "text-text-muted cursor-not-allowed"
                    }`}
                    title={t("common.delete")}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
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
