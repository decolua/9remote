"use client";

import { useState } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import SitesList from "@/features/terminal/components/SitesList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { Terminal, Monitor, FolderOpen, LogOut, X, Pencil, Trash2, Sparkles } from "@/shared/components/ui/Icon";

export default function SessionList({ sessions, connected, onSelect, onCreate, onDelete, onRename, onDisconnect, onOpenRemote, onOpenFiles, tunnelUrl, apiKey, codespaceInfo, codespaceDisconnected, onStopCodespace, retryStatus }) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
  const [showCodespaceModal, setShowCodespaceModal] = useState(false);

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
    setConfirmDialog({
      isOpen: true,
      title: "Delete Session",
      message: `Are you sure you want to delete "${sessionName}"?`,
      onConfirm: () => onDelete(sessionId)
    });
  };

  const handleLogoutWithConfirm = () => {
    setConfirmDialog({
      isOpen: true,
      title: "Logout",
      message: "Are you sure you want to logout?",
      onConfirm: onDisconnect
    });
  };

  const handleStopCodespace = () => {
    setShowCodespaceModal(false);
    onStopCodespace();
  };

  const closeConfirmDialog = () => {
    setConfirmDialog({ isOpen: false, title: "", message: "", onConfirm: null });
  };

  return (
    <div className="h-full bg-dark-700 flex flex-col overflow-hidden">
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
        
        <div className="flex items-center gap-2">
          {/* Remote Desktop Button - only show if available and connected */}
          {onOpenRemote && (
            <button
              onClick={onOpenRemote}
              disabled={!connected}
              className={`px-3 sm:px-4 py-2 text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2 border ${
                connected 
                  ? "bg-dark-500 hover:bg-dark-400 text-white border-dark-400 hover:border-brand-500" 
                  : "bg-dark-500/30 text-dark-200 border-dark-400 cursor-not-allowed"
              }`}
            >
              <Monitor className="text-brand-500" size={16} />
              <span className="hidden sm:inline">Remote</span>
            </button>
          )}

          {/* Files Button */}
          <button
            onClick={onOpenFiles}
            disabled={!connected}
            className={`px-3 sm:px-4 py-2 text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2 border ${
              connected 
                ? "bg-dark-500 hover:bg-dark-400 text-white border-dark-400 hover:border-brand-500" 
                : "bg-dark-500/30 text-dark-200 border-dark-400 cursor-not-allowed"
            }`}
          >
            <FolderOpen className="text-brand-500" size={16} />
            <span className="hidden sm:inline">Files</span>
          </button>

          {/* Sites Button */}
          <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} />

          {/* Codespace Button */}
          {codespaceInfo?.isCodespaces && (
            <button
              onClick={() => setShowCodespaceModal(true)}
              className="px-2 sm:px-3 py-2 bg-dark-500 hover:bg-dark-400 text-white text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-1 border border-dark-400 hover:border-brand-500"
              title="Codespace Info"
            >
              <Sparkles className="text-brand-500" size={16} />
              <span className="hidden sm:inline">Codespace</span>
            </button>
          )}

          {/* Logout Button */}
          <button
            onClick={handleLogoutWithConfirm}
            className="px-3 py-2 bg-dark-500 hover:bg-red-600 text-white text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2 border border-dark-400 hover:border-red-500"
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">Logout</span>
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
                        className="w-full bg-dark-700 text-white px-2 py-1 rounded-brand border border-dark-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all duration-200"
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

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={closeConfirmDialog}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
      />

      {/* Codespace Modal */}
      {showCodespaceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowCodespaceModal(false)}
          />
          <div className="relative bg-slate-800 border border-slate-700 rounded-lg shadow-2xl max-w-sm w-full">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                Codespace
              </h3>
              <button
                onClick={() => setShowCodespaceModal(false)}
                className="text-slate-400 hover:text-white transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Info */}
            <div className="px-5 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 text-sm">Name</span>
                <span className="text-white font-medium">{codespaceInfo?.codespaceName || "Unknown"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 text-sm">Status</span>
                <span className="text-green-400 font-medium flex items-center gap-1">
                  <span className="w-2 h-2 bg-green-400 rounded-full" />
                  Running
                </span>
              </div>
            </div>

            {/* Stop section */}
            <div className="px-5 py-4 border-t border-slate-700 space-y-3">
              <p className="text-slate-300 text-sm flex items-start gap-2">
                <span className="text-yellow-400">💡</span>
                Stop to save usage
              </p>
              <p className="text-slate-400 text-xs flex items-start gap-2">
                <span className="text-orange-400">⚠️</span>
                To restart, go to GitHub
              </p>
              <button
                onClick={handleStopCodespace}
                className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded transition flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                Stop Codespace
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
