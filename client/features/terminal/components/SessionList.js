"use client";

import { useState } from "react";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import SitesList from "@/features/terminal/components/SitesList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

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
    <div className="h-full bg-slate-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
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
              className={`px-3 sm:px-4 py-2 text-white text-sm font-medium rounded transition flex items-center gap-2 ${
                connected 
                  ? "bg-indigo-600 hover:bg-indigo-700" 
                  : "bg-indigo-600/50 cursor-not-allowed"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="hidden sm:inline">Remote</span>
            </button>
          )}

          {/* Files Button */}
          <button
            onClick={onOpenFiles}
            disabled={!connected}
            className={`px-3 sm:px-4 py-2 text-white text-sm font-medium rounded transition flex items-center gap-2 ${
              connected 
                ? "bg-emerald-600 hover:bg-emerald-700" 
                : "bg-emerald-600/50 cursor-not-allowed"
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span className="hidden sm:inline">Files</span>
          </button>

          {/* Sites Button */}
          <SitesList tunnelUrl={tunnelUrl} apiKey={apiKey} />

          {/* Codespace Button */}
          {codespaceInfo?.isCodespaces && (
            <button
              onClick={() => setShowCodespaceModal(true)}
              className="px-2 sm:px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded transition flex items-center gap-1"
              title="Codespace Info"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
              </svg>
              <span className="hidden sm:inline">Codespace</span>
            </button>
          )}

          {/* Logout Button */}
          <Button
            variant="danger"
            size="sm"
            onClick={handleLogoutWithConfirm}
          >
            Logout
          </Button>
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
            <p className="text-slate-400 mb-4">No active sessions</p>
            <p className="text-slate-500 text-sm">Create a new session to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`bg-slate-800 border border-slate-700 rounded-lg p-4 flex items-center justify-between transition ${
                  connected ? "hover:border-slate-600" : "opacity-50"
                }`}
              >
                <div 
                  className={`flex-1 flex items-center gap-3 ${connected && editingId !== session.id ? "cursor-pointer" : "cursor-default"}`}
                  onClick={() => connected && editingId !== session.id && onSelect(session.id)}
                >
                  {/* Terminal Icon */}
                  <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>

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
                        className="w-full bg-slate-700 text-white px-2 py-1 rounded border border-slate-600 focus:outline-none focus:border-blue-500"
                        autoFocus
                      />
                    ) : (
                      <>
                        <h3 className="text-white font-medium truncate">{session.name}</h3>
                        <p className="text-slate-400 text-sm">
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
                    className={`p-2 rounded transition ${
                      connected 
                        ? "bg-slate-700 hover:bg-blue-600 text-slate-300 hover:text-white" 
                        : "bg-slate-700/50 text-slate-500 cursor-not-allowed"
                    }`}
                    title="Edit name"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => handleDeleteWithConfirm(session.id, session.name)}
                    disabled={!connected}
                    className={`p-2 rounded transition ${
                      connected 
                        ? "bg-slate-700 hover:bg-red-600 text-slate-300 hover:text-white" 
                        : "bg-slate-700/50 text-slate-500 cursor-not-allowed"
                    }`}
                    title="Delete"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
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
