"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import FileTree from "./FileTree";
import { addRecentWorkspace } from "./WorkspaceList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

export default function FileExplorer({ 
  workspace, 
  fileSocket, 
  onBack, 
  onOpenFile, 
  onOpenGit,
  onSetWorkspace,
  isBrowsing = false
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
  const [gitStatusMap, setGitStatusMap] = useState({});
  
  // Search state
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef(null);

  // Check git and load status for workspace mode
  const checkGit = useCallback(async (dirPath) => {
    if (isBrowsing) {
      setHasGit(false);
      setGitStatusMap({});
      return;
    }
    
    const result = await fileSocket.gitStatus(dirPath);
    setHasGit(result.success);
    
    if (result.success && result.files) {
      // Build status map: path -> status, including parent folders
      const statusMap = {};
      result.files.forEach(f => {
        statusMap[f.path] = f.status;
        // Mark parent folders as having changes
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const folderPath = parts.slice(0, i).join("/");
          if (!statusMap[folderPath]) {
            statusMap[folderPath] = "folder-changed";
          }
        }
      });
      setGitStatusMap(statusMap);
    } else {
      setGitStatusMap({});
    }
  }, [fileSocket, isBrowsing]);

  // Load files
  const loadFiles = useCallback(async (dirPath) => {
    setLoading(true);
    setError("");
    
    const result = await fileSocket.getFiles(dirPath);
    
    if (result.success) {
      let filteredFiles = result.files;
      // Browse mode: only show folders
      if (isBrowsing) {
        filteredFiles = result.files.filter(f => f.type === "folder");
      }
      setFiles(filteredFiles);
      setCurrentPath(result.currentPath);
    } else {
      setError(result.error);
      setFiles([]);
    }
    
    setLoading(false);
  }, [fileSocket, isBrowsing]);

  // Search files with debounce
  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    
    if (!query || query.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    
    setSearchLoading(true);
    
    searchTimerRef.current = setTimeout(async () => {
      const result = await fileSocket.searchFiles(workspace, query);
      if (result.success) {
        setSearchResults(result.files);
      }
      setSearchLoading(false);
    }, 300);
  }, [workspace, fileSocket]);

  // Close search
  const closeSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchResults([]);
  }, []);

  useEffect(() => {
    loadFiles(workspace);
    if (!isBrowsing) {
      checkGit(workspace);
    }
  }, [workspace, loadFiles, checkGit, isBrowsing]);

  // Cleanup search timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  const handleFolderClick = (folder) => {
    loadFiles(folder.path);
  };

  const handleFileClick = (file) => {
    if (isBrowsing) return; // Browse mode: no file click
    if (file.type === "binary") {
      setError("Cannot open binary file");
      setTimeout(() => setError(""), 3000);
      return;
    }
    onOpenFile?.(file.path);
  };

  const handleGoUp = () => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/") || "/";
    loadFiles(parentPath);
  };

  const handleSetAsWorkspace = () => {
    addRecentWorkspace(currentPath);
    onSetWorkspace(currentPath);
  };

  const handleMoreClick = (file, position) => {
    setContextMenu({
      file,
      x: position.x,
      y: position.y
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
          title="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium truncate text-sm">
            {getDisplayPath()}
          </div>
        </div>

        {/* Browse mode: Set workspace button */}
        {isBrowsing && (
          <button
            onClick={handleSetAsWorkspace}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded transition font-medium"
            title="Set as workspace"
          >
            Set Workspace
          </button>
        )}

        {/* Workspace mode: Search button */}
        {!isBrowsing && (
          <button
            onClick={() => setShowSearch(true)}
            className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
            title="Search files"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        )}

        {/* Workspace mode: Git button */}
        {!isBrowsing && (
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
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21.62 11.11l-8.73-8.73a1.3 1.3 0 00-1.78 0L8.89 4.6l2.25 2.25a1.54 1.54 0 011.94 1.94l2.17 2.17a1.54 1.54 0 11-.92.86l-2.02-2.02v5.32a1.54 1.54 0 11-1.27-.07V9.65a1.54 1.54 0 01-.84-2.02L7.97 5.4 2.38 11a1.3 1.3 0 000 1.78l8.73 8.73a1.3 1.3 0 001.78 0l8.73-8.62a1.3 1.3 0 000-1.78z"/>
            </svg>
          </button>
        )}
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center gap-2 flex-shrink-0">
          <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search files..."
            className="flex-1 bg-transparent text-white placeholder-slate-400 focus:outline-none"
            autoFocus
          />
          {searchLoading && (
            <div className="w-4 h-4 border-2 border-slate-400 border-t-white rounded-full animate-spin" />
          )}
          <button
            onClick={closeSearch}
            className="p-1 text-slate-400 hover:text-white transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Search results or File tree */}
      {showSearch && searchQuery.length >= 2 ? (
        <div className="flex-1 min-h-0 overflow-auto">
          {searchLoading ? (
            <div className="flex items-center justify-center h-32 text-slate-400">
              Searching...
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-slate-400">
              No files found
            </div>
          ) : (
            <div>
              {searchResults.map((file) => (
                <button
                  key={file.path}
                  onClick={() => {
                    onOpenFile(file.path);
                    closeSearch();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 border-b border-slate-800 hover:bg-slate-800/50 transition text-left"
                >
                  <span className="text-xl flex-shrink-0">
                    {file.type === "binary" ? "📦" : "📄"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-white truncate">{file.name}</div>
                    <div className="text-slate-500 text-xs truncate">
                      {file.path.replace(workspace, "").replace(/^\//, "")}
                    </div>
                  </div>
                  {file.sizeFormatted && (
                    <span className="text-slate-500 text-xs flex-shrink-0">{file.sizeFormatted}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Go up button */}
          {currentPath !== "/" && !showSearch && (
            <button
              onClick={handleGoUp}
              className="w-full px-4 py-3 flex items-center gap-3 border-b border-slate-800 hover:bg-slate-800/50 transition text-left flex-shrink-0"
            >
              <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-green-400">......</span>
            </button>
          )}

          {/* File Tree */}
          <div className="flex-1 min-h-0 overflow-auto">
            <FileTree
              files={files}
              loading={loading}
              onFileClick={handleFileClick}
              onFolderClick={handleFolderClick}
              onMoreClick={isBrowsing ? null : handleMoreClick}
              gitStatusMap={isBrowsing ? {} : gitStatusMap}
              workspacePath={workspace}
            />
          </div>
        </>
      )}

      {/* FAB - New (workspace mode only) */}
      {!isBrowsing && (
        <button
          onClick={() => setShowNewItemModal(true)}
          className="absolute bottom-6 right-6 w-14 h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-full shadow-lg flex items-center justify-center transition"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
          <div
            className="fixed z-50 bg-slate-800 border border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-[140px]"
            style={{ 
              right: 16,
              top: Math.min(contextMenu.y, window.innerHeight - 160)
            }}
          >
            <button
              onClick={() => handleRename(contextMenu.file)}
              className="w-full px-4 py-3 text-left text-white hover:bg-slate-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Rename
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(contextMenu.file.path);
                closeContextMenu();
              }}
              className="w-full px-4 py-3 text-left text-white hover:bg-slate-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
              </svg>
              Copy path
            </button>
            <button
              onClick={() => handleDelete(contextMenu.file)}
              className="w-full px-4 py-3 text-left text-red-400 hover:bg-slate-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
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
