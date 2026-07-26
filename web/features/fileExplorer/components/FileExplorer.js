"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import FileTree from "./FileTree";
import { addRecentWorkspace } from "./WorkspaceList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { X, Search, GitBranch, Plus, FolderPlus, FilePlus, ChevronLeft, Pencil, Copy, Trash2, Loader2, File, Folder, Package, FolderOpen } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

export default function FileExplorer({ 
  workspace, 
  initialPath,
  fileSocket, 
  onBack, 
  onOpenFile, 
  onOpenGit,
  onSetWorkspace,
  onSwitchWorkspace,
  onPathChange,
  isBrowsing = false,
  hideSwitchWorkspace = false
}) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState(initialPath || workspace);
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
      // Only update if changed to prevent unnecessary re-renders
      setGitStatusMap(prevMap => {
        const prevKeys = Object.keys(prevMap);
        const newKeys = Object.keys(statusMap);
        if (prevKeys.length !== newKeys.length) return statusMap;
        for (const key of newKeys) {
          if (prevMap[key] !== statusMap[key]) return statusMap;
        }
        return prevMap; // No change, keep previous reference
      });
    } else {
      setGitStatusMap({});
    }
  }, [fileSocket, isBrowsing]);

  // Load files
  const loadFiles = useCallback(async (dirPath) => {
    setLoading(true);
    setError("");
    
    const result = await fileSocket.getFiles(dirPath, true);
    
    if (result.success) {
      let filteredFiles = result.files;
      // Browse mode: only show folders
      if (isBrowsing) {
        filteredFiles = result.files.filter(f => f.type === "folder");
      }
      // Only update if changed to prevent unnecessary re-renders
      setFiles(prevFiles => {
        if (prevFiles.length !== filteredFiles.length) return filteredFiles;
        for (let i = 0; i < filteredFiles.length; i++) {
          if (prevFiles[i]?.name !== filteredFiles[i]?.name) return filteredFiles;
        }
        return prevFiles; // No change
      });
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
    const startPath = initialPath || workspace;
    loadFiles(startPath);
    if (!isBrowsing) {
      checkGit(workspace);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, initialPath, isBrowsing]); // Removed loadFiles, checkGit from deps to prevent loop

  // Cleanup search timer
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  // Notify parent when currentPath changes (workspace mode only)
  useEffect(() => {
    if (!isBrowsing && onPathChange) {
      onPathChange(currentPath);
    }
  }, [currentPath, isBrowsing, onPathChange]);

  const handleFolderClick = (folder) => {
    loadFiles(folder.path);
  };

  const handleFileClick = (file) => {
    if (isBrowsing) return; // Browse mode: no file click
    if (file.type === "binary") {
      setError(t("files.cannotOpenBinary"));
      setTimeout(() => setError(""), 3000);
      return;
    }
    // Pass currentPath so parent can restore folder when back from editor
    onOpenFile?.(file.path, currentPath);
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
      title: t("files.deleteConfirmTitle"),
      message: t("files.deleteConfirmMessage", { name: file.name }),
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
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
          title={t("common.close")}
        >
          <X size={20} />
        </button>
        
        <div className="flex-1 min-w-0">
          <div className="text-text font-medium truncate text-sm">
            {getDisplayPath()}
          </div>
        </div>

        {/* Browse mode: Set workspace button */}
        {isBrowsing && (
          <button
            onClick={() => { vibrate(); handleSetAsWorkspace(); }}
            className="px-3 py-2 bg-brand-500 hover:bg-brand-600 text-white text-xs rounded-brand transition-all duration-150 ease-out active:scale-[0.97] font-medium shadow-sm"
            title={t("files.setAsWorkspaceTitle")}
          >
            {t("files.setWorkspace")}
          </button>
        )}

        {/* Workspace mode: Switch workspace button */}
        {!isBrowsing && onSwitchWorkspace && !hideSwitchWorkspace && (
          <button
            onClick={() => { vibrate(); onSwitchWorkspace(); }}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={t("files.switchWorkspace")}
          >
            <FolderOpen className="text-brand-500" size={20} />
          </button>
        )}

        {/* Workspace mode: Search button */}
        {!isBrowsing && (
          <button
            onClick={() => { vibrate(); setShowSearch(true); }}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
            title={t("files.searchFiles")}
          >
            <Search className="text-brand-500" size={20} />
          </button>
        )}

        {/* Workspace mode: Git button */}
        {!isBrowsing && (
          <button
            onClick={() => { vibrate(); onOpenGit(); }}
            disabled={!hasGit}
            className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.96] ${
              hasGit 
                ? "bg-surface-2 hover:bg-surface-3 text-text" 
                : "bg-surface-2/30 text-text-muted cursor-not-allowed"
            }`}
            title={hasGit ? t("git.title") : t("files.noGitRepo")}
          >
            <GitBranch className={hasGit ? "text-brand-500" : "text-text-muted"} size={20} />
          </button>
        )}
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="bg-surface-2 px-4 py-2 flex items-center gap-2 flex-shrink-0">
          <Search className="text-text-muted flex-shrink-0" size={20} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t("files.searchPlaceholder")}
            className="flex-1 bg-transparent text-text placeholder-text-subtle focus:outline-none"
            autoFocus
          />
          {searchLoading && (
            <Loader2 className="animate-spin text-brand-500" size={16} />
          )}
          <button
            onClick={() => { vibrate(); closeSearch(); }}
            className="p-1 text-text-muted hover:text-text transition-colors"
          >
            <X size={20} />
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
            <div className="flex items-center justify-center h-32 text-text-muted">
              {t("files.searching")}
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-text-muted">
              {t("files.noFilesFound")}
            </div>
          ) : (
            <div>
              {searchResults.map((file) => (
                <button
                  key={file.path}
                  onClick={() => {
                    vibrate();
                    onOpenFile(file.path);
                    closeSearch();
                  }}
                  className="w-full px-4 py-3 flex items-center gap-3 border-b border-border hover:bg-surface transition-colors text-left"
                >
                  <span className="flex-shrink-0">
                    {file.type === "binary" ? <Package size={20} className="text-red-500/70" /> : <File size={20} className="text-text-subtle" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-text truncate">{file.name}</div>
                    <div className="text-text-muted text-xs truncate">
                      {file.path.replace(workspace, "").replace(/^\//, "")}
                    </div>
                  </div>
                  {file.sizeFormatted && (
                    <span className="text-text-muted text-xs flex-shrink-0">{file.sizeFormatted}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Go up button - hide when at workspace root or filesystem root */}
          {currentPath !== "/" && !isAtWorkspace && !showSearch && (
            <button
              onClick={() => { vibrate(); handleGoUp(); }}
              className="w-full px-4 py-3 flex items-center gap-3 border-b border-border hover:bg-surface transition-colors text-left flex-shrink-0"
            >
              <ChevronLeft className="text-green-500" size={28} />
              <span className="text-green-500">{currentPath.split("/").pop() || "/"}</span>
            </button>
          )}

          {/* File Tree or Grid (browse mode) */}
          <div className={`flex-1 min-h-0 overflow-auto ${!isBrowsing ? "pb-20" : ""}`}>
            {isBrowsing ? (
              // Grid view for browse mode
              <div className="p-4">
                {loading ? (
                  <div className="flex items-center justify-center h-32 text-text-muted">{t("common.loading")}</div>
                ) : files.length === 0 ? (
                  <div className="flex items-center justify-center h-32 text-text-muted">{t("files.emptyFolder")}</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {files.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => { vibrate(); handleFolderClick(file); }}
                        className="bg-surface hover:bg-surface-2 rounded-brand-lg p-2 flex flex-col items-center gap-1 transition-all duration-150 ease-out active:scale-[0.98] text-center"
                      >
                        <Folder size={48} className="text-yellow-500/80" />
                        <span className="text-text text-xs font-medium truncate w-full">{file.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              // List view for workspace mode
              <FileTree
                files={files}
                loading={loading}
                onFileClick={handleFileClick}
                onFolderClick={handleFolderClick}
                onMoreClick={handleMoreClick}
                gitStatusMap={gitStatusMap}
                workspacePath={workspace}
              />
            )}
          </div>
        </>
      )}

      {/* FAB - New (workspace mode only) */}
      {!isBrowsing && (
        <button
          onClick={() => { vibrate(); setShowNewItemModal(true); }}
          className="absolute bottom-6 right-6 w-14 h-14 bg-brand-500 hover:bg-brand-600 text-white rounded-full shadow-lg shadow-brand-500/30 flex items-center justify-center transition-all duration-200"
        >
          <Plus size={24} />
        </button>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
          <div
            className="fixed z-50 card-elev overflow-hidden min-w-[140px]"
            style={{ 
              right: 16,
              top: Math.min(contextMenu.y, window.innerHeight - 160)
            }}
          >
            <button
              onClick={() => { vibrate(); handleRename(contextMenu.file); }}
              className="w-full px-4 py-3 text-left text-text hover:bg-surface-2 flex items-center gap-3 transition-colors"
            >
              <Pencil size={16} />
              {t("files.rename")}
            </button>
            <button
              onClick={() => {
                vibrate();
                navigator.clipboard.writeText(contextMenu.file.path);
                closeContextMenu();
              }}
              className="w-full px-4 py-3 text-left text-text hover:bg-surface-2 flex items-center gap-3 transition-colors"
            >
              <Copy size={16} />
              {t("files.copyPath")}
            </button>
            <button
              onClick={() => { vibrate(); handleDelete(contextMenu.file); }}
              className="w-full px-4 py-3 text-left text-red-400 hover:bg-surface-2 flex items-center gap-3 transition-colors"
            >
              <Trash2 size={16} />
              {t("files.delete")}
            </button>
          </div>
        </>
      )}

      {/* New Item Modal */}
      {showNewItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setShowNewItemModal(false)} />
          <div className="relative card-elev w-full max-w-sm">
            <div className="px-4 py-3">
              <h3 className="text-text font-semibold">{t("files.createNew")}</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex gap-2">
                <button
                  onClick={() => { vibrate(); setNewItemType("file"); }}
                  className={`flex-1 py-2 rounded-brand transition flex items-center justify-center gap-2 ${
                    newItemType === "file" 
                      ? "bg-brand-500 text-white" 
                      : "bg-surface-2 text-text"
                  }`}
                >
                  <File size={16} className="text-text-subtle" /> {t("files.file")}
                </button>
                <button
                  onClick={() => { vibrate(); setNewItemType("folder"); }}
                  className={`flex-1 py-2 rounded-brand transition flex items-center justify-center gap-2 ${
                    newItemType === "folder" 
                      ? "bg-brand-500 text-white" 
                      : "bg-surface-2 text-text"
                  }`}
                >
                  <Folder size={16} className="text-orange-500/70" /> {t("files.folder")}
                </button>
              </div>
              <input
                type="text"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateItem()}
                placeholder={newItemType === "file" ? t("files.placeholderFile") : t("files.placeholderFolder")}
                className="w-full px-3 py-2 bg-surface-2 rounded-brand text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { vibrate(); setShowNewItemModal(false); }}
                  className="flex-1 py-2 bg-surface-2 text-text rounded-brand hover:bg-surface-3 transition-all duration-150 ease-out active:scale-[0.98]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => { vibrate(); handleCreateItem(); }}
                  className="flex-1 py-2 bg-brand-500 text-white rounded-brand hover:bg-brand-600 transition-all duration-150 ease-out active:scale-[0.98]"
                >
                  {t("common.create")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setRenameModal(null)} />
          <div className="relative card-elev w-full max-w-sm">
            <div className="px-4 py-3">
              <h3 className="text-text font-semibold">{t("files.rename")}</h3>
            </div>
            <div className="p-4 space-y-4">
              <input
                type="text"
                value={renameModal.newName}
                onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit()}
                className="w-full px-3 py-2 bg-surface-2 rounded-brand text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { vibrate(); setRenameModal(null); }}
                  className="flex-1 py-2 bg-surface-2 text-text rounded-brand hover:bg-surface-3 transition-all duration-150 ease-out active:scale-[0.98]"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => { vibrate(); handleRenameSubmit(); }}
                  className="flex-1 py-2 bg-brand-500 text-white rounded-brand hover:bg-brand-600 transition-all duration-150 ease-out active:scale-[0.98]"
                >
                  {t("files.rename")}
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
