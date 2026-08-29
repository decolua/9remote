"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import FileTree from "./FileTree";
import { addRecentWorkspace } from "./WorkspaceList";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { X, Search, GitBranch, Plus, ChevronLeft, Pencil, Copy, Trash2, File, Folder, Package, FolderOpen, Download } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { useI18n } from "@/shared/i18n";
import { buildWorkspaceGitStatus, sameStatusMap } from "@/features/fileExplorer/lib/gitStatusMap";
import { useFileTransfer } from "@/features/fileExplorer/hooks/useFileTransfer";
import { SearchBar, TransferBanner, NewItemModal, RenameModal, ConflictModal } from "./FileExplorerModals";

export default function FileExplorer({
  workspace,
  initialPath,
  fileBus,
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

  const [isDesktop] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false));

  // Check git and load status for workspace mode
  const checkGit = useCallback(async (dirPath) => {
    if (isBrowsing) {
      setHasGit(false);
      setGitStatusMap({});
      return;
    }

    const result = await buildWorkspaceGitStatus(fileBus, dirPath);
    setHasGit(result.hasGit);
    const statusMap = result.map;
    // Keep the previous reference when nothing changed — the map feeds every row.
    setGitStatusMap((prev) => (sameStatusMap(prev, statusMap) ? prev : statusMap));
  }, [fileBus, isBrowsing]);

  // Load files
  const loadFiles = useCallback(async (dirPath) => {
    setLoading(true);
    setError("");

    const result = await fileBus.getFiles(dirPath, true);

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
  }, [fileBus, isBrowsing]);

  const {
    transfer, dragOver, conflict, downloadState,
    startUpload, handleDrop, handleDragOver, handleDragLeave, handleDownload, resolveConflict
  } = useFileTransfer({ fileBus, currentPath, isBrowsing, onDone: loadFiles, onError: setError });

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
      const result = await fileBus.searchFiles(workspace, query);
      if (result.success) {
        setSearchResults(result.files);
      }
      setSearchLoading(false);
    }, 300);
  }, [workspace, fileBus]);

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
    setContextMenu({ file, x: position.x, y: position.y });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleDelete = (file) => {
    closeContextMenu();
    setConfirmDialog({
      isOpen: true,
      title: t("files.deleteConfirmTitle"),
      message: t("files.deleteConfirmMessage", { name: file.name }),
      onConfirm: async () => {
        const result = await fileBus.deleteItem(file.path);
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
    const result = await fileBus.renameItem(renameModal.file.path, newPath);

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
    const result = await fileBus.createItem(itemPath, newItemType);

    if (result.success) {
      loadFiles(currentPath);
      setShowNewItemModal(false);
      setNewItemName("");
    } else {
      setError(result.error);
    }
  };

  // Device-picker upload: reset value so picking the same file twice still fires onChange.
  const uploadFileInputRef = useRef(null);
  const uploadFolderInputRef = useRef(null);
  const handleUploadPick = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!picked.length) return;
    const items = picked.map((f) => ({ file: f, relativePath: f.webkitRelativePath || f.name }));
    setShowNewItemModal(false);
    startUpload(items);
  };

  const getDisplayPath = () => currentPath.replace(/^\/Users\/[^/]+/, "~");

  const isAtWorkspace = currentPath === workspace;
  const headerBtn = "p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]";

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface px-4 py-3 flex items-center gap-2 flex-shrink-0">
        <button onClick={() => { vibrate(); onBack(); }} className={headerBtn} title={t("common.close")}>
          <X size={20} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="text-text font-medium truncate text-sm">{getDisplayPath()}</div>
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
          <button onClick={() => { vibrate(); onSwitchWorkspace(); }} className={headerBtn} title={t("files.switchWorkspace")}>
            <FolderOpen className="text-brand-500" size={20} />
          </button>
        )}

        {/* Workspace mode: Search button */}
        {!isBrowsing && (
          <button onClick={() => { vibrate(); setShowSearch(true); }} className={headerBtn} title={t("files.searchFiles")}>
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

      {showSearch && (
        <SearchBar query={searchQuery} loading={searchLoading} onChange={handleSearch} onClose={closeSearch} />
      )}

      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {transfer && (
        <TransferBanner
          label={`${t("files.copying")} ${transfer.done + 1}/${transfer.total}: ${transfer.current}`}
          ratio={transfer.ratio}
        />
      )}

      {downloadState && (
        <TransferBanner label={`${t("files.downloading")}: ${downloadState.name}`} ratio={downloadState.ratio} />
      )}

      {/* Search results or File tree */}
      {showSearch && searchQuery.length >= 2 ? (
        <div className="flex-1 min-h-0 overflow-auto">
          {searchLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted">{t("files.searching")}</div>
          ) : searchResults.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-text-muted">{t("files.noFilesFound")}</div>
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
                    <div className="text-text truncate" title={file.name}>{file.name}</div>
                    <div className="text-text-muted text-xs truncate" title={file.path}>
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
          <div
            className={`flex-1 min-h-0 overflow-auto ${!isBrowsing ? "pb-20" : ""} ${dragOver ? "bg-brand-500/5 ring-2 ring-inset ring-brand-500/40" : ""}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
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
                        <span className="text-text text-xs font-medium truncate w-full" title={file.name}>{file.name}</span>
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
          className="absolute bottom-[max(1.5rem,calc(env(safe-area-inset-bottom)+0.5rem))] right-6 w-14 h-14 bg-brand-500 hover:bg-brand-600 text-white rounded-full shadow-lg shadow-brand-500/30 flex items-center justify-center transition-all duration-200"
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
            style={{ right: 16, top: Math.min(contextMenu.y, window.innerHeight - 160) }}
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
                navigator.clipboard?.writeText(contextMenu.file.path).catch(() => {});
                closeContextMenu();
              }}
              className="w-full px-4 py-3 text-left text-text hover:bg-surface-2 flex items-center gap-3 transition-colors"
            >
              <Copy size={16} />
              {t("files.copyPath")}
            </button>
            {isDesktop && (
              <button
                onClick={() => { vibrate(); closeContextMenu(); handleDownload(contextMenu.file); }}
                className="w-full px-4 py-3 text-left text-text hover:bg-surface-2 flex items-center gap-3 transition-colors"
              >
                <Download size={16} />
                {t("files.download")}
              </button>
            )}
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

      {showNewItemModal && (
        <>
          <NewItemModal
            type={newItemType}
            name={newItemName}
            onTypeChange={setNewItemType}
            onNameChange={setNewItemName}
            onSubmit={handleCreateItem}
            onPickFile={() => uploadFileInputRef.current?.click()}
            onPickFolder={() => uploadFolderInputRef.current?.click()}
            onClose={() => setShowNewItemModal(false)}
          />
          <input ref={uploadFileInputRef} type="file" multiple className="hidden" onChange={handleUploadPick} />
          <input ref={uploadFolderInputRef} type="file" className="hidden" webkitdirectory="" onChange={handleUploadPick} />
        </>
      )}

      {renameModal && (
        <RenameModal
          value={renameModal.newName}
          onChange={(v) => setRenameModal({ ...renameModal, newName: v })}
          onSubmit={handleRenameSubmit}
          onClose={() => setRenameModal(null)}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ isOpen: false })}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
      />

      {conflict && <ConflictModal name={conflict.name} onResolve={resolveConflict} />}
    </div>
  );
}
