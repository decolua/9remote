"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/shared/components/ui/Icon";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { vibrate } from "@/shared/utils/vibration";
import { relativeTo, basename } from "@/features/fileExplorer/lib/pathUtils";
import { useFileTreeState } from "@/features/fileExplorer/hooks/useFileTreeState";
import { useFileOperations } from "@/features/fileExplorer/hooks/useFileOperations";
import ExplorerRow, { TruncatedNote, indentFor } from "./ExplorerRow";

const LONG_PRESS_MS = 500;
const DRAG_MIME = "application/x-file-paths";

export default function ExplorerPanel({
  workspace,
  fileSocket,
  onOpenFile,
  activeFile,
  onSwitchWorkspace
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const contextMenuRef = useRef(null);
  const contextMenuPos = useClampedMenu(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [newItemModal, setNewItemModal] = useState(null);
  const [newItemValue, setNewItemValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(() => new Set());
  const [dragOverPath, setDragOverPath] = useState(null);
  const lastClickedRef = useRef(null);

  const longPressTimer = useRef(null);
  const renameInputRef = useRef(null);
  const newItemInputRef = useRef(null);

  const getRelative = useCallback((p) => relativeTo(workspace, p), [workspace]);

  const {
    tree, expanded, loading, truncatedDirs, gitStatusMap,
    showHidden, setShowHidden,
    loadDir, loadGitStatus, toggleFolder, expandDir, refreshAll
  } = useFileTreeState({ workspace, fileSocket });

  const { createItem, renameItem, deleteItem, duplicateItem, moveTo } = useFileOperations({
    fileSocket, loadDir, loadGitStatus, expandDir, onOpenFile,
    onMoved: () => setSelectedPaths(new Set())
  });

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  // Focus rename input
  useEffect(() => {
    if (renameTarget && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTarget]);

  useEffect(() => {
    if (newItemModal && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [newItemModal]);

  const handleFileClick = useCallback(
    (file, e) => {
      vibrate();
      const mod = e?.metaKey || e?.ctrlKey;
      const shift = e?.shiftKey;
      // Multi-select: Ctrl/Cmd toggle, Shift range (simple - flat list)
      if (mod) {
        setSelectedPaths(prev => {
          const next = new Set(prev);
          if (next.has(file.path)) next.delete(file.path);
          else next.add(file.path);
          return next;
        });
        lastClickedRef.current = file.path;
        return;
      }
      if (shift && lastClickedRef.current) {
        setSelectedPaths(new Set([lastClickedRef.current, file.path]));
        return;
      }
      // Single click - clear multi-select
      setSelectedPaths(new Set([file.path]));
      lastClickedRef.current = file.path;
      if (file.type === "folder") {
        setSelectedFolder(file.path);
        toggleFolder(file);
      } else {
        onOpenFile?.(file.path);
      }
    },
    [toggleFolder, onOpenFile]
  );

  // Determine target folder for new items
  const getNewItemTargetDir = useCallback(() => {
    if (selectedFolder && tree.has(selectedFolder)) return selectedFolder;
    return workspace;
  }, [selectedFolder, tree, workspace]);

  const handleCreate = useCallback(
    async (type) => {
      const name = newItemValue.trim();
      if (!name) return;
      const dir = newItemModal?.dir || getNewItemTargetDir();
      await createItem(dir, name, type);
      setNewItemModal(null);
      setNewItemValue("");
    },
    [newItemValue, newItemModal, getNewItemTargetDir, createItem]
  );

  const handleRenameSubmit = useCallback(async () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    await renameItem(renameTarget, newName);
    setRenameTarget(null);
  }, [renameTarget, renameValue, renameItem]);

  const copyToClipboard = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  }, []);

  const openContextMenu = useCallback((e, file) => {
    e.preventDefault();
    e.stopPropagation();
    vibrate();
    setContextMenu({ file, x: e.clientX, y: e.clientY });
  }, []);

  // Long-press for touch devices
  const startLongPress = useCallback((e, file) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      vibrate();
      setContextMenu({ file, x, y });
    }, LONG_PRESS_MS);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const readDragPaths = (e) => {
    const data = e.dataTransfer.getData(DRAG_MIME);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
  };

  const renderRow = (file, depth) => {
    const isFolder = file.type === "folder";
    const isExpanded = isFolder && expanded.has(file.path);
    const isSelected = selectedPaths.has(file.path);

    return (
      <ExplorerRow
        key={file.path}
        file={file}
        depth={depth}
        isFolder={isFolder}
        isExpanded={isExpanded}
        isLoading={isFolder && loading.has(file.path)}
        isActive={activeFile === file.path}
        isSelected={isSelected}
        isRenaming={renameTarget?.path === file.path}
        isDragOver={dragOverPath === file.path && isFolder}
        gitStatus={gitStatusMap[getRelative(file.path)]}
        renameValue={renameValue}
        renameInputRef={renameInputRef}
        onRenameChange={setRenameValue}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={() => setRenameTarget(null)}
        onToggleFolder={() => toggleFolder(file)}
        onClick={(e) => handleFileClick(file, e)}
        onContextMenu={(e) => openContextMenu(e, file)}
        onTouchStart={(e) => startLongPress(e, file)}
        onTouchEnd={cancelLongPress}
        onDragStart={(e) => {
          const paths = isSelected ? [...selectedPaths] : [file.path];
          e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOverPath(file.path);
        }}
        onDragLeave={() => setDragOverPath(p => p === file.path ? null : p)}
        onDrop={(e) => {
          if (!isFolder) return;
          e.preventDefault();
          setDragOverPath(null);
          const paths = readDragPaths(e);
          if (paths) moveTo(paths, file.path);
        }}
      >
        {isFolder && isExpanded && (
          <div>
            {(tree.get(file.path) || []).map((child) => renderRow(child, depth + 1))}
            {truncatedDirs.has(file.path) && <TruncatedNote depth={depth + 1} />}
          </div>
        )}
      </ExplorerRow>
    );
  };

  const rootFiles = useMemo(() => tree.get(workspace) || [], [tree, workspace]);
  const workspaceName = useMemo(() => basename(workspace), [workspace]);

  const openNewItemModal = (type, dir) => {
    vibrate();
    setNewItemModal({ type, dir });
    setNewItemValue("");
  };

  // Context menu items based on file type
  const buildMenuItems = (file) => {
    if (!file) return [];
    const isFolder = file.type === "folder";
    const items = [];
    if (isFolder) {
      items.push({ label: "Open in Terminal", icon: "Terminal", action: () => fileSocket.openInTerminal(file.path) });
      items.push({ label: "New File", icon: "Plus", action: () => openNewItemModal("file", file.path) });
      items.push({ label: "New Folder", icon: "FolderOpen", action: () => openNewItemModal("folder", file.path) });
    } else {
      items.push({ label: "Open", icon: "File", action: () => onOpenFile?.(file.path) });
    }
    items.push({ label: "Reveal in OS", icon: "FolderOpen", action: () => fileSocket.revealInOS(file.path) });
    items.push({
      label: "Rename",
      icon: "Pencil",
      action: () => { setRenameTarget(file); setRenameValue(file.name); }
    });
    items.push({ label: "Duplicate", icon: "Copy", action: () => duplicateItem(file) });
    items.push({ label: "Copy Path", icon: "Copy", action: () => copyToClipboard(file.path) });
    items.push({ label: "Copy Relative Path", icon: "Copy", action: () => copyToClipboard(getRelative(file.path)) });
    items.push({ label: "Delete", icon: "Trash2", danger: true, action: () => setConfirmDelete(file) });
    return items;
  };

  const headerBtn = "text-text-muted hover:text-text p-1 rounded hover:bg-surface-2";

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg text-text overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-3 py-2 border-b border-border flex items-center gap-2 sticky top-0 z-10">
        <button
          onClick={() => { vibrate(); onSwitchWorkspace?.(); }}
          className="flex items-center gap-1 flex-1 min-w-0 hover:text-text"
        >
          <span className="text-xs uppercase tracking-wider text-text-muted font-medium truncate">
            {workspaceName || "No Workspace"}
          </span>
          <Icon name="ChevronDown" size={12} className="text-text-muted shrink-0" />
        </button>
        <button onClick={() => openNewItemModal("file", getNewItemTargetDir())} className={headerBtn} title="New File">
          <Icon name="Plus" size={14} />
        </button>
        <button onClick={() => openNewItemModal("folder", getNewItemTargetDir())} className={headerBtn} title="New Folder">
          <Icon name="FolderOpen" size={14} />
        </button>
        <button onClick={refreshAll} className={headerBtn} title="Refresh">
          <Icon name="RefreshCw" size={14} />
        </button>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`p-1 rounded hover:bg-surface-2 ${showHidden ? "text-text" : "text-text-muted hover:text-text"}`}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          <Icon name={showHidden ? "Eye" : "EyeOff"} size={14} />
        </button>
      </div>

      {/* Tree */}
      <div
        className="flex-1 overflow-auto py-1"
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        onDrop={(e) => {
          e.preventDefault();
          const paths = readDragPaths(e);
          if (paths) moveTo(paths, workspace);
        }}
      >
        {rootFiles.length === 0 && !loading.has(workspace) ? (
          <div className="text-text-subtle text-xs px-3 py-4 text-center">Empty workspace</div>
        ) : (
          <>
            {rootFiles.map((file) => renderRow(file, 0))}
            {truncatedDirs.has(workspace) && (
              <div className="text-[11px] text-text-muted italic py-0.5 px-3">
                Showing first 300 entries — use search for the rest.
              </div>
            )}
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-surface-2 border border-border rounded-brand shadow-lg py-1 min-w-[180px]"
          style={{ left: contextMenuPos.left, top: contextMenuPos.top }}
          onClick={(e) => e.stopPropagation()}
        >
          {buildMenuItems(contextMenu.file).map((item, i) => (
            <button
              key={i}
              onClick={() => {
                vibrate();
                item.action();
                setContextMenu(null);
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-surface-3 ${
                item.danger ? "text-red-400" : "text-text"
              }`}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* New item modal */}
      {newItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => setNewItemModal(null)} />
          <div className="relative bg-surface-2 border border-border rounded-brand p-4 w-full max-w-sm">
            <h3 className="text-sm font-semibold text-text mb-2">
              {newItemModal.type === "folder" ? "New Folder" : "New File"}
            </h3>
            <p className="text-xs text-text-muted mb-2 truncate">
              in {getRelative(newItemModal.dir) || workspaceName || "/"}
            </p>
            <input
              ref={newItemInputRef}
              value={newItemValue}
              onChange={(e) => setNewItemValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate(newItemModal.type);
                else if (e.key === "Escape") setNewItemModal(null);
              }}
              placeholder={newItemModal.type === "folder" ? "folder name" : "file name"}
              className="w-full bg-surface-3 text-text text-sm px-2 py-1.5 rounded outline-none border border-border focus:border-brand-500"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => { vibrate(); setNewItemModal(null); }}
                className="px-3 py-1.5 text-sm bg-surface-3 hover:bg-surface text-text rounded-brand"
              >
                Cancel
              </button>
              <button
                onClick={() => { vibrate(); handleCreate(newItemModal.type); }}
                className="px-3 py-1.5 text-sm bg-brand-500 hover:bg-brand-500/80 text-white rounded-brand"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteItem(confirmDelete)}
        title="Delete"
        message={`Are you sure you want to delete "${confirmDelete?.name}"?`}
        confirmText="Delete"
        cancelText="Cancel"
      />
    </div>
  );
}
