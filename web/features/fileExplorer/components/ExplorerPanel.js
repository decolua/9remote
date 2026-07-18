"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/shared/components/ui/Icon";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { vibrate } from "@/shared/utils/vibration";
import {
  FILE_ICON_NAMES,
  LANGUAGE_MAP,
  GIT_STATUS_COLORS,
  STORAGE_KEYS,
  isImageFile,
  isVideoFile,
  isAudioFile,
  isPdfFile
} from "../constants/fileExplorer.js";

const INDENT_BASE = 12;
const INDENT_STEP = 12;
const LONG_PRESS_MS = 500;

// Resolve icon name by file type / extension
function getFileIconName(file) {
  if (file.type === "folder") return FILE_ICON_NAMES.folder;
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  const lang = LANGUAGE_MAP[ext];
  if (lang && FILE_ICON_NAMES[lang]) return FILE_ICON_NAMES[lang];
  if (isImageFile(file.path)) return FILE_ICON_NAMES.image;
  if (isVideoFile(file.path) || isAudioFile(file.path)) return FILE_ICON_NAMES.video;
  if (isPdfFile(file.path)) return FILE_ICON_NAMES.pdf;
  return FILE_ICON_NAMES.file;
}

function getFileIcon(file) {
  const name = getFileIconName(file);
  const cls = file.type === "folder" ? "text-blue-400" : "text-text-muted";
  return <Icon name={name} size={16} className={cls} />;
}

function joinPath(dir, name) {
  if (!dir) return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function dirname(p) {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

// Read persisted expanded set
function loadExpanded() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.expandedFolders);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveExpanded(set) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEYS.expandedFolders, JSON.stringify([...set]));
  } catch {}
}

export default function ExplorerPanel({
  workspace,
  fileSocket,
  onOpenFile,
  activeFile,
  onSwitchWorkspace
}) {
  const [tree, setTree] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(() => new Set());
  const [gitStatusMap, setGitStatusMap] = useState({});
  const [contextMenu, setContextMenu] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [newItemModal, setNewItemModal] = useState(null);
  const [newItemValue, setNewItemValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(() => new Set());
  const [dragOverPath, setDragOverPath] = useState(null);
  const [showHidden, setShowHidden] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEYS.showHidden);
      if (raw === null) return true;
      return JSON.parse(raw) !== false;
    } catch {
      return true;
    }
  });
  const lastClickedRef = useRef(null);

  const longPressTimer = useRef(null);
  const renameInputRef = useRef(null);
  const newItemInputRef = useRef(null);

  const getRelative = useCallback(
    (p) => (p && workspace ? p.replace(`${workspace}/`, "") : p),
    [workspace]
  );

  // Load directory children into cache
  const loadDir = useCallback(
    async (dirPath) => {
      setLoading((prev) => {
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });
      const res = await fileSocket.getFiles(dirPath, showHidden);
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
      if (res?.success) {
        setTree((prev) => {
          const next = new Map(prev);
          next.set(dirPath, res.files || []);
          return next;
        });
        return res.files || [];
      }
      return [];
    },
    [fileSocket, showHidden]
  );

  // Load git status and propagate folder-changed up parents
  const loadGitStatus = useCallback(async () => {
    if (!workspace) return;
    const res = await fileSocket.gitStatus(workspace);
    if (!res?.success) {
      setGitStatusMap({});
      return;
    }
    const map = {};
    const list = res.files || res.status || [];
    list.forEach((entry) => {
      const rel = entry.path || entry.file;
      const status = entry.status || entry.code;
      if (!rel || !status) return;
      map[rel] = status;
      // Propagate folder-changed to parent dirs
      const parts = rel.split("/");
      for (let i = parts.length - 1; i > 0; i -= 1) {
        const parentRel = parts.slice(0, i).join("/");
        if (!map[parentRel]) map[parentRel] = "folder-changed";
      }
    });
    setGitStatusMap(map);
  }, [fileSocket, workspace]);

  // Initial mount: load workspace root + restore expanded + git status
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    (async () => {
      const persisted = loadExpanded();
      const restored = new Set([workspace]);
      await loadDir(workspace);
      // Restore previously-expanded folders that are subpaths of workspace
      for (const p of persisted) {
        if (typeof p === "string" && p.startsWith(workspace)) {
          restored.add(p);
          await loadDir(p);
          if (!alive) return;
        }
      }
      if (!alive) return;
      setExpanded(restored);
      loadGitStatus();
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // Refresh git badges when files saved/changed elsewhere
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => loadGitStatus();
    const events = ["fileExplorer:fileSaved", "fileExplorer:fileCreated", "fileExplorer:fileDeleted", "fileExplorer:fileRenamed"];
    events.forEach(ev => window.addEventListener(ev, handler));
    return () => events.forEach(ev => window.removeEventListener(ev, handler));
  }, [loadGitStatus]);

  // Persist expanded
  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);

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

  const toggleFolder = useCallback(
    async (folder) => {
      vibrate();
      const path = folder.path;
      if (expanded.has(path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }
      if (!tree.has(path)) {
        await loadDir(path);
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
    },
    [expanded, tree, loadDir]
  );

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

  const refreshAll = useCallback(async () => {
    vibrate();
    const dirs = [...tree.keys()];
    await Promise.all(dirs.map((d) => loadDir(d)));
    loadGitStatus();
  }, [tree, loadDir, loadGitStatus]);

  // Persist + reload cached dirs when toggle hidden files
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.showHidden, JSON.stringify(showHidden));
    if (tree.size > 0) {
      const dirs = [...tree.keys()];
      Promise.all(dirs.map((d) => loadDir(d))).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

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
      const itemPath = joinPath(dir, name);
      const res = await fileSocket.createItem(itemPath, type);
      if (res?.success) {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("fileExplorer:fileCreated"));
        await loadDir(dir);
        if (type === "folder") {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.add(dir);
            return next;
          });
        } else {
          onOpenFile?.(itemPath);
        }
      }
      setNewItemModal(null);
      setNewItemValue("");
    },
    [newItemValue, newItemModal, getNewItemTargetDir, fileSocket, loadDir, onOpenFile]
  );

  const handleRenameSubmit = useCallback(async () => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const parent = dirname(renameTarget.path);
    const newPath = joinPath(parent, newName);
    const res = await fileSocket.renameItem(renameTarget.path, newPath);
    if (res?.success) {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("fileExplorer:fileRenamed"));
      await loadDir(parent);
    }
    setRenameTarget(null);
  }, [renameTarget, renameValue, fileSocket, loadDir]);

  const handleDelete = useCallback(
    async (file) => {
      const parent = dirname(file.path);
      const res = await fileSocket.deleteItem(file.path);
      if (res?.success) {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("fileExplorer:fileDeleted"));
        await loadDir(parent);
      }
    },
    [fileSocket, loadDir]
  );

  const handleDuplicate = useCallback(
    async (file) => {
      if (file.type === "folder") return;
      const read = await fileSocket.readFile(file.path);
      if (!read?.success) return;
      const dotIdx = file.name.lastIndexOf(".");
      const base = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
      const ext = dotIdx > 0 ? file.name.slice(dotIdx) : "";
      const copyName = `${base} copy${ext}`;
      const parent = dirname(file.path);
      const copyPath = joinPath(parent, copyName);
      await fileSocket.createItem(copyPath, "file");
      await fileSocket.writeFile(copyPath, read.content || "");
      await loadDir(parent);
    },
    [fileSocket, loadDir]
  );

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
  const startLongPress = useCallback(
    (e, file) => {
      const touch = e.touches?.[0];
      if (!touch) return;
      const x = touch.clientX;
      const y = touch.clientY;
      longPressTimer.current = setTimeout(() => {
        vibrate();
        setContextMenu({ file, x, y });
      }, LONG_PRESS_MS);
    },
    []
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Render git status badge
  const renderGitBadge = (file) => {
    const rel = getRelative(file.path);
    const status = gitStatusMap[rel];
    if (!status) return null;
    if (status === "folder-changed") {
      return <span className="w-1.5 h-1.5 rounded-full bg-blue-400/70 mr-1" />;
    }
    const colorCls = GIT_STATUS_COLORS[status] || "text-text-muted";
    return <span className={`text-[11px] font-bold ${colorCls} ml-1`}>{status}</span>;
  };

  // Recursive tree renderer
  // Move files via drag-drop (uses renameItem as move)
  const handleMoveTo = useCallback(async (paths, targetDir) => {
    if (!paths?.length || !targetDir) return;
    for (const src of paths) {
      const name = src.split("/").pop();
      const dest = joinPath(targetDir, name);
      if (src === dest || dest.startsWith(src + "/")) continue;
      await fileSocket.renameItem(src, dest);
    }
    // Refresh affected dirs
    const dirs = new Set([targetDir, ...paths.map(p => dirname(p))]);
    for (const d of dirs) await loadDir(d);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("fileExplorer:fileRenamed"));
    loadGitStatus();
    setSelectedPaths(new Set());
  }, [fileSocket, loadDir, loadGitStatus]);

  const renderRow = (file, depth) => {
    const isFolder = file.type === "folder";
    const isExpanded = isFolder && expanded.has(file.path);
    const isLoading = isFolder && loading.has(file.path);
    const isActive = activeFile === file.path;
    const isRenaming = renameTarget?.path === file.path;
    const isSelected = selectedPaths.has(file.path);
    const isDragOver = dragOverPath === file.path && isFolder;
    const padLeft = INDENT_BASE + depth * INDENT_STEP;

    return (
      <div key={file.path}>
        <div
          draggable={!isRenaming}
          onDragStart={(e) => {
            const paths = isSelected ? [...selectedPaths] : [file.path];
            e.dataTransfer.setData("application/x-file-paths", JSON.stringify(paths));
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
            const data = e.dataTransfer.getData("application/x-file-paths");
            if (!data) return;
            try { handleMoveTo(JSON.parse(data), file.path); } catch {}
          }}
          className={`group flex items-center gap-1 pr-2 py-0.5 cursor-pointer select-none text-sm ${
            isDragOver ? "bg-brand-500/30 ring-1 ring-brand-500" :
            isActive || isSelected ? "bg-brand-500/20" : "hover:bg-surface-2"
          }`}
          style={{ paddingLeft: padLeft }}
          onContextMenu={(e) => openContextMenu(e, file)}
          onTouchStart={(e) => startLongPress(e, file)}
          onTouchEnd={cancelLongPress}
          onTouchMove={cancelLongPress}
          onClick={(e) => !isRenaming && handleFileClick(file, e)}
        >
          {isFolder ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                toggleFolder(file);
              }}
              className="flex items-center justify-center w-4 h-4 text-text-muted"
            >
              {isLoading ? (
                <Icon name="Loader2" size={12} className="animate-spin" />
              ) : isExpanded ? (
                <Icon name="ChevronDown" size={14} />
              ) : (
                <Icon name="ChevronRight" size={14} />
              )}
            </span>
          ) : (
            <span className="w-4 h-4" />
          )}

          {isFolder ? (
            <Icon
              name={isExpanded ? "FolderOpen" : "Folder"}
              size={16}
              className="text-blue-400 shrink-0"
            />
          ) : (
            getFileIcon(file)
          )}

          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameSubmit();
                else if (e.key === "Escape") setRenameTarget(null);
              }}
              className="flex-1 bg-surface-3 text-text text-sm px-1 py-0.5 rounded outline-none border border-brand-500"
            />
          ) : (
            <span className={`flex-1 truncate text-text ${(() => { const s = gitStatusMap[getRelative(file.path)]; if (s === "folder-changed") return "text-yellow-400"; return GIT_STATUS_COLORS[s] || ""; })()}`}>{file.name}</span>
          )}

          {!isRenaming && renderGitBadge(file)}

          {!isRenaming && (
            <button
              onClick={(e) => openContextMenu(e, file)}
              className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text px-1"
            >
              <Icon name="MoreHorizontal" size={14} />
            </button>
          )}
        </div>

        {isFolder && isExpanded && (
          <div>
            {(tree.get(file.path) || []).map((child) => renderRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootFiles = useMemo(() => tree.get(workspace) || [], [tree, workspace]);
  const workspaceName = useMemo(() => {
    if (!workspace) return "";
    const parts = workspace.split("/").filter(Boolean);
    return parts[parts.length - 1] || workspace;
  }, [workspace]);

  // Context menu items based on file type
  const buildMenuItems = (file) => {
    if (!file) return [];
    const isFolder = file.type === "folder";
    const items = [];
    if (isFolder) {
      items.push({
        label: "Open in Terminal",
        icon: "Terminal",
        action: () => fileSocket.openInTerminal(file.path)
      });
      items.push({
        label: "New File",
        icon: "Plus",
        action: () => {
          setNewItemModal({ type: "file", dir: file.path });
          setNewItemValue("");
        }
      });
      items.push({
        label: "New Folder",
        icon: "FolderOpen",
        action: () => {
          setNewItemModal({ type: "folder", dir: file.path });
          setNewItemValue("");
        }
      });
    } else {
      items.push({
        label: "Open",
        icon: "File",
        action: () => onOpenFile?.(file.path)
      });
    }
    items.push({
      label: "Reveal in OS",
      icon: "FolderOpen",
      action: () => fileSocket.revealInOS(file.path)
    });
    items.push({
      label: "Rename",
      icon: "Pencil",
      action: () => {
        setRenameTarget(file);
        setRenameValue(file.name);
      }
    });
    items.push({
      label: "Duplicate",
      icon: "Copy",
      action: () => handleDuplicate(file)
    });
    items.push({
      label: "Copy Path",
      icon: "Copy",
      action: () => copyToClipboard(file.path)
    });
    items.push({
      label: "Copy Relative Path",
      icon: "Copy",
      action: () => copyToClipboard(getRelative(file.path))
    });
    items.push({
      label: "Delete",
      icon: "Trash2",
      danger: true,
      action: () => setConfirmDelete(file)
    });
    return items;
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-bg text-text overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-3 py-2 border-b border-border flex items-center gap-2 sticky top-0 z-10">
        <button
          onClick={() => {
            vibrate();
            onSwitchWorkspace?.();
          }}
          className="flex items-center gap-1 flex-1 min-w-0 hover:text-text"
        >
          <span className="text-xs uppercase tracking-wider text-text-muted font-medium truncate">
            {workspaceName || "No Workspace"}
          </span>
          <Icon name="ChevronDown" size={12} className="text-text-muted shrink-0" />
        </button>
        <button
          onClick={() => {
            vibrate();
            setNewItemModal({ type: "file", dir: getNewItemTargetDir() });
            setNewItemValue("");
          }}
          className="text-text-muted hover:text-text p-1 rounded hover:bg-surface-2"
          title="New File"
        >
          <Icon name="Plus" size={14} />
        </button>
        <button
          onClick={() => {
            vibrate();
            setNewItemModal({ type: "folder", dir: getNewItemTargetDir() });
            setNewItemValue("");
          }}
          className="text-text-muted hover:text-text p-1 rounded hover:bg-surface-2"
          title="New Folder"
        >
          <Icon name="FolderOpen" size={14} />
        </button>
        <button
          onClick={refreshAll}
          className="text-text-muted hover:text-text p-1 rounded hover:bg-surface-2"
          title="Refresh"
        >
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
          const data = e.dataTransfer.getData("application/x-file-paths");
          if (!data) return;
          try { handleMoveTo(JSON.parse(data), workspace); } catch {}
        }}
      >
        {rootFiles.length === 0 && !loading.has(workspace) ? (
          <div className="text-text-subtle text-xs px-3 py-4 text-center">Empty workspace</div>
        ) : (
          rootFiles.map((file) => renderRow(file, 0))
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-surface-2 border border-border rounded-brand shadow-lg py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={() => setNewItemModal(null)}
          />
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
                onClick={() => {
                  vibrate();
                  setNewItemModal(null);
                }}
                className="px-3 py-1.5 text-sm bg-surface-3 hover:bg-surface text-text rounded-brand"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  vibrate();
                  handleCreate(newItemModal.type);
                }}
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
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
        title="Delete"
        message={`Are you sure you want to delete "${confirmDelete?.name}"?`}
        confirmText="Delete"
        cancelText="Cancel"
      />
    </div>
  );
}
