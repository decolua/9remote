"use client";

import { useState, useEffect, useCallback } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useSites } from "@/features/terminal/hooks/useSites";
import { Terminal, Pencil, Trash2, Settings } from "@/shared/components/ui/Icon";

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onLogout, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus, isActive = true, socketRef }) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState({ isOpen: false, sessionId: null, sessionName: "" });

  // Slide menu store
  const { open: openMenu, setContext, setCallbacks, setSites, setLoadingSites } = useSlideMenuStore();

  // Use sites hook for DRY code
  const { sites, loading: loadingSites, loadSites, openSite } = useSites(tunnelUrl, apiKey);

  // Sync sites to store
  useEffect(() => {
    setSites(sites);
    setLoadingSites(loadingSites);
  }, [sites, loadingSites, setSites, setLoadingSites]);

  // Handle site selection
  const handleSelectSite = useCallback(async (site) => {
    await openSite(site);
  }, [openSite]);

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
    });

    setCallbacks({
      onRemote: onOpenRemote,
      onFiles: onOpenFiles,
      onSites: loadSites,
      onSelectSite: handleSelectSite,
      onRefreshSites: loadSites,
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
    loadSites,
    handleSelectSite,
    setContext,
    setCallbacks,
    socketRef
  ]);

  const handleCreate = async () => {
    if (creating || !connected) return;
    setCreating(true);
    await onCreate(newName || `Terminal ${sessions.length + 1}`);
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

  return (
    <div className="h-full bg-gradient-to-br from-dark-900 via-orange-700/20 to-dark-900/10 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-dark-600 border-b border-dark-400 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-brand-500/10 rounded-brand">
            <Terminal className="text-brand-500" size={20} />
          </div>
          <h1 className="text-white text-lg font-semibold">9Remote</h1>
          {/* Connection indicator */}
          <span 
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500 animate-pulse"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          {!connected && codespaceDisconnected && (
            <span className="text-red-400 text-xs">Codespace stopped</span>
          )}
        </div>
        
        {/* Menu Button */}
        <button
          onClick={() => openMenu()}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-brand-500 rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500"
          title="Menu"
        >
          <Settings size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 overflow-auto modal-scrollable">
        {/* Create new session */}
        <div className="mb-6 flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Terminal name (optional)"
            disabled={!connected}
          />
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={creating || !connected}
            loading={creating}
            className="whitespace-nowrap"
          >
            + New
          </Button>
        </div>

        {/* Sessions list */}
        {sessions.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex p-4 bg-dark-600 rounded-brand-lg mb-4">
              <Terminal className="text-dark-100" size={48} />
            </div>
            <p className="text-dark-50 mb-2 font-medium">No active sessions</p>
            <p className="text-dark-100 text-sm">Create a new session to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`bg-dark-600 border border-dark-400 rounded-brand-lg p-4 flex items-center justify-between transition-all duration-200 ${
                  connected ? "hover:border-brand-500/50 hover:shadow-lg hover:shadow-brand-500/10" : "opacity-50"
                }`}
              >
                <div 
                  className={`flex-1 flex items-center gap-3 ${connected && editingId !== session.id ? "cursor-pointer" : "cursor-default"}`}
                  onClick={() => connected && editingId !== session.id && onSelect(session.id)}
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
                        className="w-full bg-dark-700 text-white px-2 py-1 rounded-brand border border-dark-400 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-transparent transition-all duration-200"
                        autoFocus
                      />
                    ) : (
                      <>
                        <h3 className="text-white font-medium truncate">{session.name}</h3>
                        <p className="text-dark-100 text-sm">
                          Created {new Date(session.createdAt).toLocaleTimeString()}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 ml-3">
                  {/* Edit Button */}
                  <button
                    onClick={() => handleStartEdit(session)}
                    disabled={!connected}
                    className={`p-2 rounded-brand transition-all duration-200 ${
                      connected 
                        ? "bg-dark-500 hover:bg-brand-500 text-dark-100 hover:text-white border border-dark-400 hover:border-brand-500" 
                        : "bg-dark-500/50 text-dark-200 cursor-not-allowed border border-dark-400"
                    }`}
                    title="Edit name"
                  >
                    <Pencil size={16} />
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => handleDeleteWithConfirm(session.id, session.name)}
                    disabled={!connected}
                    className={`p-2 rounded-brand transition-all duration-200 ${
                      connected 
                        ? "bg-dark-500 hover:bg-red-600 text-dark-100 hover:text-white border border-dark-400 hover:border-red-500" 
                        : "bg-dark-500/50 text-dark-200 cursor-not-allowed border border-dark-400"
                    }`}
                    title="Delete"
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
        title="Delete Session"
        message={`Are you sure you want to delete "${deleteConfirm.sessionName}"?`}
      />
    </div>
  );
}
