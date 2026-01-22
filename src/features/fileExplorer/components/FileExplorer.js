"use client";

import { useState, useEffect, useCallback } from "react";
import FileTree from "./FileTree";
import { addRecentWorkspace } from "./WorkspaceList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

export default function FileExplorer({ 
  workspace, 
  fileSocket, 
  onBack, 
  onOpenFile, 
  onOpenGit,
  onSetWorkspace 
}) {
  const [currentPath, setCurrentPath] = useState(workspace);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [contextMenu, setContextMenu] = useState(null);
  const [showNewItemModal, setShowNewItemModal] = useState(false);
  const [newItemType, setNewItemType] = useState("file");
  const [newItemName, setNewItemName] = useState("");
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false });
  const [renameModal, setRenameModal] = useState(null);
  const [hasGit, setHasGit] = useState(false);

  // Check if workspace has git
  const checkGit = useCallback(async (dirPath) => {
    const result = await fileSocket.gitStatus(dirPath);
    setHasGit(result.success);
  }, [fileSocket]);

  // Load files
  const loadFiles = useCallback(async (dirPath) => {
    setLoading(true);
    setError("");
    
    const result = await fileSocket.getFiles(dirPath);
    
    if (result.success) {
      setFiles(result.files);
      setCurrentPath(result.currentPath);
    } else {
      setError(result.error);
      setFiles([]);
    }
    
    setLoading(false);
  }, [fileSocket]);

  useEffect(() => {
    loadFiles(workspace);
    checkGit(workspace);
  }, [workspace, loadFiles, checkGit]);

  const handleFolderClick = (folder) => {
    loadFiles(folder.path);
  };

  const handleFileClick = (file) => {
    if (file.type === "binary") {
      setError("Cannot open binary file");
      setTimeout(() => setError(""), 3000);
      return;
    }
    onOpenFile(file.path);
  };

  const handleGoUp = () => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    loadFiles(parentPath);
  };

  const handleSetAsWorkspace = () => {
    addRecentWorkspace(currentPath);
    onSetWorkspace(currentPath);
  };

  const handleLongPress = (file, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      file,
      x: rect.left,
      y: rect.bottom
    });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleDelete = (file) => {
    closeContextMenu();
    setConfirmDialog({
      isOpen: true,
      title: "Delete",
      message: `Delete "${file.name}"?`,
      onConfirm: async () => {
        const result = await fileSocket.deleteItem(file.path);
        if (result.success) {
          loadFiles(currentPath);
        } else {
          setError(result.error);
        }
      }
    });
  };

  const handleRename = (file) => {
    closeContextMenu();
    setRenameModal({ file, newName: file.name });
  };

  const handleRenameSubmit = async () => {
    if (!renameModal || !renameModal.newName.trim()) return;
    
    const newPath = currentPath + "/" + renameModal.newName.trim();
    const result = await fileSocket.renameItem(renameModal.file.path, newPath);
    
    if (result.success) {
      loadFiles(currentPath);
    } else {
      setError(result.error);
    }
    
    setRenameModal(null);
  };

  const handleCreateItem = async () => {
    if (!newItemName.trim()) return;
    
    const itemPath = currentPath + "/" + newItemName.trim();
    const result = await fileSocket.createItem(itemPath, newItemType);
    
    if (result.success) {
      loadFiles(currentPath);
      setShowNewItemModal(false);
      setNewItemName("");
    } else {
      setError(result.error);
    }
  };

  const getDisplayPath = () => {
    return currentPath.replace(/^\/Users\/[^/]+/, "~");
  };

  const isAtWorkspace = currentPath === workspace;

  return (
    <div className="h-full bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium truncate text-sm">
            {getDisplayPath()}
          </div>
        </div>

        {!isAtWorkspace && (
          <button
            onClick={handleSetAsWorkspace}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded transition"
            title="Set as workspace"
          >
            Set
          </button>
        )}

        <button
          onClick={onOpenGit}
          disabled={!hasGit}
          className={`p-2 rounded transition ${
            hasGit 
              ? "bg-orange-600 hover:bg-orange-700 text-white" 
              : "bg-slate-700 text-slate-500 cursor-not-allowed"
          }`}
          title={hasGit ? "Git" : "No git repository"}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Go up button */}
      {currentPath !== "/" && (
        <button
          onClick={handleGoUp}
          className="w-full px-4 py-3 flex items-center gap-3 border-b border-slate-800 hover:bg-slate-800/50 transition text-left"
        >
          <span className="text-xl">⬆️</span>
          <span className="text-slate-400">..</span>
        </button>
      )}

      {/* File Tree */}
      <FileTree
        files={files}
        loading={loading}
        onFileClick={handleFileClick}
        onFolderClick={handleFolderClick}
        onLongPress={handleLongPress}
      />

      {/* FAB - New */}
      <button
        onClick={() => setShowNewItemModal(true)}
        className="absolute bottom-6 right-6 w-14 h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-full shadow-lg flex items-center justify-center transition"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
          <div
            className="fixed z-50 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => handleRename(contextMenu.file)}
              className="w-full px-4 py-3 text-left text-white hover:bg-slate-700 flex items-center gap-2"
            >
              <span>📝</span> Rename
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(contextMenu.file.path);
                closeContextMenu();
              }}
              className="w-full px-4 py-3 text-left text-white hover:bg-slate-700 flex items-center gap-2"
            >
              <span>📋</span> Copy path
            </button>
            <button
              onClick={() => handleDelete(contextMenu.file)}
              className="w-full px-4 py-3 text-left text-red-400 hover:bg-slate-700 flex items-center gap-2"
            >
              <span>🗑️</span> Delete
            </button>
          </div>
        </>
      )}

      {/* New Item Modal */}
      {showNewItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowNewItemModal(false)} />
          <div className="relative bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-sm">
            <div className="px-4 py-3 border-b border-slate-700">
              <h3 className="text-white font-semibold">Create New</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => setNewItemType("file")}
                  className={`flex-1 py-2 rounded transition ${
                    newItemType === "file" 
                      ? "bg-emerald-600 text-white" 
                      : "bg-slate-700 text-slate-300"
                  }`}
                >
                  📄 File
                </button>
                <button
                  onClick={() => setNewItemType("folder")}
                  className={`flex-1 py-2 rounded transition ${
                    newItemType === "folder" 
                      ? "bg-emerald-600 text-white" 
                      : "bg-slate-700 text-slate-300"
                  }`}
                >
                  📁 Folder
                </button>
              </div>
              <input
                type="text"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateItem()}
                placeholder={newItemType === "file" ? "filename.js" : "folder-name"}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:border-emerald-500"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setShowNewItemModal(false)}
                  className="flex-1 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateItem}
                  className="flex-1 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setRenameModal(null)} />
          <div className="relative bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-full max-w-sm">
            <div className="px-4 py-3 border-b border-slate-700">
              <h3 className="text-white font-semibold">Rename</h3>
            </div>
            <div className="p-4 space-y-4">
              <input
                type="text"
                value={renameModal.newName}
                onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit()}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:border-emerald-500"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setRenameModal(null)}
                  className="flex-1 py-2 bg-slate-700 text-white rounded hover:bg-slate-600 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRenameSubmit}
                  className="flex-1 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition"
                >
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ isOpen: false })}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
      />
    </div>
  );
}
