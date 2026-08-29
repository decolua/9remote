"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/shared/components/ui/Icon";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { relativeTo, basename, dirname } from "@/features/fileExplorer/lib/pathUtils";
import { isDiffPath, isHtmlFile, parseRepoDiffPath } from "../constants/fileExplorer.js";
import { useFileTreeState } from "@/features/fileExplorer/hooks/useFileTreeState";
import { useFileOperations } from "@/features/fileExplorer/hooks/useFileOperations";
import ExplorerRow, { TruncatedNote, indentFor } from "./ExplorerRow";
import { dataTransferToItems } from "@/features/fileExplorer/lib/dataTransfer";
import { ConflictModal } from "./FileExplorerModals";
import { isMac } from "@/features/terminal/constants/shortcuts";

const LONG_PRESS_MS = 500;
const DRAG_MIME = "application/x-file-paths";

// Safari lacks webkitdirectory, so "New Folder" there uploads loose files instead.
const dirPickerSupported = () =>
  typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");

// A drop carries either OS files or an internal path list — never both.
const readDragPaths = (e) => {
  const data = e.dataTransfer.getData(DRAG_MIME);
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
};

const hasOsFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

export default function ExplorerPanel({
  workspace,
  fileSocket,
  onOpenFile,
  activeFile,
  onSwitchWorkspace,
  onNewTerminal,
  compact = false,
  onlyChanged = false,
  onActions
}) {
  const { t } = useI18n();
  const [contextMenu, setContextMenu] = useState(null);
  const contextMenuRef = useRef(null);
  const contextMenuPos = useClampedMenu(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [newItemModal, setNewItemModal] = useState(null);
  const [newItemValue, setNewItemValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);   // { files: [...] }
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(() => new Set());
  // Read at event time so drag handlers can stay identity-stable across selection changes
  const selectionRef = useRef(selectedPaths);
  useEffect(() => { selectionRef.current = selectedPaths; }, [selectedPaths]);
  const renameValueRef = useRef(renameValue);
  useEffect(() => { renameValueRef.current = renameValue; }, [renameValue]);
  const renameTargetRef = useRef(renameTarget);
  useEffect(() => { renameTargetRef.current = renameTarget; }, [renameTarget]);
  const [dragOverPath, setDragOverPath] = useState(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [clipboard, setClipboard] = useState(null);           // { paths, mode: copy|cut }
  const [upload, setUpload] = useState(null);                 // { total, done }
  const [uploadConflict, setUploadConflict] = useState(null); // { name, resolve }
  // Focused row for the keyboard; `anchorRef` is where a shift-range measures from —
  // one cursor for both would collapse every shift-arrow back to a two-row range.
  const [cursorPath, setCursorPath] = useState(null);

  const treeRef = useRef(null);
  const anchorRef = useRef(null);
  const pickFilesRef = useRef(null);
  const pickFolderRef = useRef(null);
  const [dirPickerOk] = useState(dirPickerSupported);
  const longPressTimer = useRef(null);
  const renameInputRef = useRef(null);
  const newItemInputRef = useRef(null);

  const getRelative = useCallback((p) => relativeTo(workspace, p), [workspace]);

  const {
    tree, expanded, loading, truncatedDirs, gitStatusMap,
    showHidden, setShowHidden,
    loadDir, loadGitStatus, toggleFolder, expandDir, collapseAll, refreshAll
  } = useFileTreeState({ workspace, fileSocket });

  const { createItem, renameItem, deleteItem, deleteMany, duplicateItem, moveTo, pasteInto } = useFileOperations({
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
      const len = renameInputRef.current.value.length;
      renameInputRef.current.setSelectionRange(len, len);
    }
  }, [renameTarget]);

  useEffect(() => {
    if (newItemModal && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [newItemModal]);

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

  // Reads rename state from refs: this is a prop on every memoized row, so depending
  // on renameValue would re-render the whole tree on each keystroke of one input.
  const handleRenameSubmit = useCallback(async () => {
    const target = renameTargetRef.current;
    if (!target) return;
    const newName = renameValueRef.current.trim();
    if (!newName || newName === target.name) {
      setRenameTarget(null);
      return;
    }
    await renameItem(target, newName);
    setRenameTarget(null);
  }, [renameItem]);

  const copyToClipboard = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  }, []);

  const openContextMenu = useCallback((e, file) => {
    e.preventDefault();
    e.stopPropagation();
    vibrate();
    // Right-clicking outside the selection moves it; inside it, the whole set stays.
    setSelectedPaths((prev) => (prev.has(file.path) ? prev : new Set([file.path])));
    setCursorPath(file.path);
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

  // The Git tab's tab id is virtual; resolve it once so both the highlight and the
  // reveal below compare against a path a row actually carries.
  const activePath = useMemo(() => {
    if (!activeFile) return null;
    if (!isDiffPath(activeFile)) return activeFile;
    const { repoPath, filePath } = parseRepoDiffPath(activeFile);
    return filePath ? `${repoPath || workspace}/${filePath}` : null;
  }, [activeFile, workspace]);

  // A folder survives the filter when anything inside it changed — buildGitStatusMap
  // already marks ancestors as "folder-changed" for exactly this reason.
  const passesChangedFilter = (file) => {
    if (!onlyChanged) return true;
    return !!gitStatusMap[getRelative(file.path)];
  };

  // The rows the user can actually see, in screen order — what shift-range and the
  // arrow keys walk. Kept flat here; the render below stays recursive for the nesting.
  const visibleRows = useMemo(() => {
    const out = [];
    const walk = (dir, depth) => {
      for (const file of (tree.get(dir) || [])) {
        if (onlyChanged && !gitStatusMap[getRelative(file.path)]) continue;
        out.push({ file, depth });
        if (file.type === "folder" && expanded.has(file.path)) walk(file.path, depth + 1);
      }
    };
    walk(workspace, 0);
    return out;
  }, [tree, expanded, gitStatusMap, onlyChanged, workspace, getRelative]);

  const fileAt = useCallback((path) => visibleRows.find((r) => r.file.path === path)?.file || null, [visibleRows]);

  // Every selected row as a file object; falls back to the row the menu was opened on.
  const selectionFiles = useCallback((fallback) => {
    const picked = visibleRows.filter((r) => selectedPaths.has(r.file.path)).map((r) => r.file);
    if (picked.length) return picked;
    return fallback ? [fallback] : [];
  }, [visibleRows, selectedPaths]);

  const selectRange = useCallback((fromPath, toPath) => {
    const a = visibleRows.findIndex((r) => r.file.path === fromPath);
    const b = visibleRows.findIndex((r) => r.file.path === toPath);
    if (a === -1 || b === -1) return new Set([toPath]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return new Set(visibleRows.slice(lo, hi + 1).map((r) => r.file.path));
  }, [visibleRows]);

  const handleFileClick = useCallback(
    (file, e) => {
      vibrate();
      // The tree owns the shortcuts, so a click must land focus on it.
      treeRef.current?.focus({ preventScroll: true });
      const mod = e?.metaKey || e?.ctrlKey;
      if (mod) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          next.has(file.path) ? next.delete(file.path) : next.add(file.path);
          return next;
        });
        setCursorPath(file.path);
        anchorRef.current = file.path;
        return;
      }
      if (e?.shiftKey && anchorRef.current) {
        setSelectedPaths(selectRange(anchorRef.current, file.path));
        setCursorPath(file.path);
        return;
      }
      setSelectedPaths(new Set([file.path]));
      setCursorPath(file.path);
      anchorRef.current = file.path;
      if (file.type === "folder") {
        setSelectedFolder(file.path);
        toggleFolder(file);
      } else {
        onOpenFile?.(file.path);
      }
    },
    [toggleFolder, onOpenFile, selectRange]
  );

  // Which folder a new item / paste lands in: the folder itself when one is targeted,
  // the parent when a file is, the workspace otherwise.
  const dirOf = useCallback((file) => {
    if (!file) return workspace;
    return file.type === "folder" ? file.path : dirname(file.path);
  }, [workspace]);

  const askDelete = useCallback((file) => {
    const files = selectionFiles(file);
    if (files.length) setConfirmDelete({ files });
  }, [selectionFiles]);

  const runDelete = useCallback(async () => {
    const files = confirmDelete?.files || [];
    setConfirmDelete(null);
    if (files.length === 1) await deleteItem(files[0]);
    else await deleteMany(files);
    setSelectedPaths(new Set());
  }, [confirmDelete, deleteItem, deleteMany]);

  const copySelection = useCallback((file, mode) => {
    const paths = selectionFiles(file).map((f) => f.path);
    if (paths.length) setClipboard({ paths, mode });
  }, [selectionFiles]);

  const pasteClipboard = useCallback(async (file) => {
    if (!clipboard?.paths?.length) return;
    await pasteInto(clipboard.paths, dirOf(file), clipboard.mode);
    if (clipboard.mode === "cut") setClipboard(null);
  }, [clipboard, pasteInto, dirOf]);

  // The one upload path: a drop and the modal's file picker both land here.
  const runUpload = useCallback(async (items, targetDir) => {
    if (!items.length) return;
    setUpload({ total: items.length, done: 0 });
    await fileSocket.uploadFiles(targetDir, items, {
      onConflict: (file, relativePath) =>
        new Promise((resolve) => setUploadConflict({ name: relativePath || file?.name, resolve })),
      onFileDone: () => setUpload((p) => (p ? { ...p, done: p.done + 1 } : p)),
      onError: () => setUpload((p) => (p ? { ...p, done: p.done + 1 } : p))
    });
    setUpload(null);
    setUploadConflict(null);
    await loadDir(targetDir);
    expandDir(targetDir);
    loadGitStatus();
  }, [fileSocket, loadDir, expandDir, loadGitStatus]);

  // Files dragged in from the OS: upload into the folder they were dropped on.
  const uploadInto = useCallback(async (dataTransfer, targetDir) => {
    runUpload(await dataTransferToItems(dataTransfer), targetDir);
  }, [runUpload]);

  // One stable handler set shared by every row (they take the row's file) — rows are
  // memoized, so a closure built per row per render would re-render the whole tree on
  // every keystroke, selection click and drag-over.
  const handleRowRenameCancel = useCallback(() => setRenameTarget(null), []);
  const handleRowDragStart = useCallback((e, file) => {
    const sel = selectionRef.current;
    const paths = sel.has(file.path) ? [...sel] : [file.path];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  }, []);
  const handleRowDragOver = useCallback((e, file) => {
    const os = hasOsFiles(e);
    if (file.type !== "folder" && !os) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = os ? "copy" : "move";
    if (file.type === "folder") setDragOverPath(file.path);
  }, []);
  const handleRowDragLeave = useCallback((file) => {
    setDragOverPath((p) => (p === file.path ? null : p));
  }, []);
  const handleRowDrop = useCallback((e, file) => {
    const os = hasOsFiles(e);
    if (file.type !== "folder" && !os) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    setRootDragOver(false);
    // A file row takes the drop on behalf of its folder.
    if (os) { uploadInto(e.dataTransfer, dirOf(file)); return; }
    const paths = readDragPaths(e);
    if (paths) moveTo(paths, file.path);
  }, [uploadInto, dirOf, moveTo]);

  // <input type="file"> picks: webkitRelativePath carries the folder structure.
  const handlePickedFiles = useCallback((e) => {
    const dir = newItemModal?.dir || getNewItemTargetDir();
    const items = [...e.target.files].map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
    e.target.value = "";
    setNewItemModal(null);
    runUpload(items, dir);
  }, [newItemModal, getNewItemTargetDir, runUpload]);

  const moveCursor = useCallback((delta, extend) => {
    if (!visibleRows.length) return;
    const at = visibleRows.findIndex((r) => r.file.path === cursorPath);
    const next = visibleRows[Math.min(visibleRows.length - 1, Math.max(0, (at === -1 ? 0 : at + delta)))];
    if (!next) return;
    const path = next.file.path;
    if (extend && anchorRef.current) setSelectedPaths(selectRange(anchorRef.current, path));
    else { setSelectedPaths(new Set([path])); anchorRef.current = path; }
    setCursorPath(path);
    treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visibleRows, cursorPath, selectRange]);

  // VSCode-style tree keys. Typing inside the rename input never reaches here — the
  // input stops on its own keydown handlers.
  const handleKeyDown = useCallback((e) => {
    if (renameTarget || newItemModal || confirmDelete) return;
    const cursor = fileAt(cursorPath);
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelectedPaths(new Set(visibleRows.map((r) => r.file.path)));
      anchorRef.current = visibleRows[0]?.file.path || null;
      return;
    }
    if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(cursor, "copy"); return; }
    if (mod && e.key.toLowerCase() === "x") { e.preventDefault(); copySelection(cursor, "cut"); return; }
    if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(cursor); return; }

    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveCursor(1, e.shiftKey); return;
      case "ArrowUp": e.preventDefault(); moveCursor(-1, e.shiftKey); return;
      case "ArrowRight":
        if (!cursor) return;
        e.preventDefault();
        if (cursor.type === "folder" && !expanded.has(cursor.path)) toggleFolder(cursor);
        else moveCursor(1, false);
        return;
      case "ArrowLeft":
        if (!cursor) return;
        e.preventDefault();
        if (cursor.type === "folder" && expanded.has(cursor.path)) toggleFolder(cursor);
        else moveCursor(-1, false);
        return;
      case "Enter":
        if (!cursor) return;
        e.preventDefault();
        // macOS renames on Enter; elsewhere it opens, and F2 renames.
        if (isMac()) { setRenameTarget(cursor); setRenameValue(cursor.name); }
        else if (cursor.type === "folder") toggleFolder(cursor);
        else onOpenFile?.(cursor.path);
        return;
      case "F2":
        if (!cursor) return;
        e.preventDefault();
        setRenameTarget(cursor);
        setRenameValue(cursor.name);
        return;
      case "Delete":
      case "Backspace":
        if (!cursor) return;
        e.preventDefault();
        askDelete(cursor);
        return;
      case "Escape":
        setSelectedPaths(new Set());
        setClipboard(null);
        return;
      default:
    }
  }, [renameTarget, newItemModal, confirmDelete, cursorPath, fileAt, visibleRows, expanded,
      toggleFolder, onOpenFile, moveCursor, copySelection, pasteClipboard, askDelete]);


  const renderRow = (file, depth) => {
    if (!passesChangedFilter(file)) return null;
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
        isActive={activePath === file.path}
        isSelected={isSelected}
        isRenaming={renameTarget?.path === file.path}
        isDragOver={dragOverPath === file.path && isFolder}
        isCut={clipboard?.mode === "cut" && clipboard.paths.includes(file.path)}
        gitStatus={gitStatusMap[getRelative(file.path)]}
        renameValue={renameTarget?.path === file.path ? renameValue : ""}
        renameInputRef={renameInputRef}
        onRenameChange={setRenameValue}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRowRenameCancel}
        onToggleFolder={toggleFolder}
        onClick={handleFileClick}
        onContextMenu={openContextMenu}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onDragStart={handleRowDragStart}
        onDragOver={handleRowDragOver}
        onDragLeave={handleRowDragLeave}
        onDrop={handleRowDrop}
        compact={compact}
      >
        {isFolder && isExpanded && (
          <div>
            {(tree.get(file.path) || []).map((child) => renderRow(child, depth + 1))}
            {truncatedDirs.has(file.path) && <TruncatedNote depth={depth + 1} compact={compact} />}
          </div>
        )}
      </ExplorerRow>
    );
  };

  const rootFiles = useMemo(() => tree.get(workspace) || [], [tree, workspace]);

  // Turning the filter on reveals the folders holding changes: load their children (a
  // folder never opened has none cached) and mark them expanded. Expanding for real,
  // rather than forcing isExpanded, keeps the chevron working — the user can still fold
  // a branch away while the filter is on.
  useEffect(() => {
    if (!onlyChanged) return;
    let alive = true;
    (async () => {
      for (const relPath of Object.keys(gitStatusMap)) {
        if (gitStatusMap[relPath] !== "folder-changed") continue;
        const abs = `${workspace}/${relPath}`;
        if (!tree.has(abs)) {
          await loadDir(abs);
          if (!alive) return;
        }
        expandDir(abs);
      }
    })();
    return () => { alive = false; };
  // gitStatusMap is the trigger; tree is read but must not re-run this on every load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyChanged, gitStatusMap, workspace]);

  // Scroll the open file into view when it changes elsewhere (a tab switch, a git-diff
  // click) — otherwise the tree keeps showing wherever the user last scrolled to.
  useEffect(() => {
    if (!activePath || !treeRef.current) return;
    // Deferred a tick so the row exists when a newly-expanded folder brought it in. A
    // file outside this root simply finds no row and nothing scrolls.
    const id = setTimeout(() => {
      const row = treeRef.current?.querySelector(`[data-path="${CSS.escape(activePath)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => clearTimeout(id);
  }, [activePath, tree]);

  const workspaceName = useMemo(() => basename(workspace), [workspace]);

  const openNewItemModal = (type, dir) => {
    vibrate();
    setNewItemModal({ type, dir });
    setNewItemValue("");
  };

  // Hand the tree's own actions to a host that draws its own header, so a docked panel
  // has one strip of buttons rather than two.
  useEffect(() => {
    if (!onActions) return;
    onActions({
      newFile: () => openNewItemModal("file", getNewItemTargetDir()),
      newFolder: () => openNewItemModal("folder", getNewItemTargetDir()),
      refresh: refreshAll,
      collapseAll,
      hasExpanded: expanded.size > 0,
      showHidden,
      toggleHidden: () => setShowHidden((v) => !v)
    });
    return () => onActions(null);
  // openNewItemModal/getNewItemTargetDir are recreated per render; the deps that matter
  // are the ones that change what the actions do.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onActions, showHidden, refreshAll, collapseAll, expanded.size, workspace]);

  // Context menu items. With more than one row selected the destructive/clipboard
  // entries act on the whole set — the single-item ones drop out.
  const buildMenuItems = (file) => {
    if (!file) return [];
    const isFolder = file.type === "folder";
    const picked = selectionFiles(file);
    const many = picked.length > 1;
    const items = [];
    if (!many && isFolder) {
      // In-app terminal rooted here — the only terminal entry point from the tree.
      if (onNewTerminal) {
        items.push({ label: t("workspaces.openHere"), icon: "Terminal", action: () => onNewTerminal(file.path) });
      }
      items.push({ label: "New File", icon: "Plus", action: () => openNewItemModal("file", file.path) });
      items.push({ label: "New Folder", icon: "FolderOpen", action: () => openNewItemModal("folder", file.path) });
    } else if (!many) {
      items.push({ label: "Open", icon: "File", action: () => onOpenFile?.(file.path) });
      // HTML opens rendered rather than as source — the tab still holds the editor.
      if (isHtmlFile(file.path)) {
        items.push({ label: t("editor.preview"), icon: "Eye", action: () => onOpenFile?.(file.path, { preview: true }) });
      }
    }
    items.push({ label: "Cut", icon: "Scissors", action: () => copySelection(file, "cut") });
    items.push({ label: "Copy", icon: "Copy", action: () => copySelection(file, "copy") });
    if (clipboard?.paths?.length) {
      items.push({ label: "Paste", icon: "ClipboardPaste", action: () => pasteClipboard(file) });
    }
    if (!many) {
      items.push({ label: "Reveal in OS", icon: "FolderOpen", action: () => fileSocket.revealInOS(file.path) });
      items.push({
        label: "Rename",
        icon: "Pencil",
        action: () => { setRenameTarget(file); setRenameValue(file.name); }
      });
      items.push({ label: "Duplicate", icon: "Copy", action: () => duplicateItem(file) });
      items.push({ label: "Copy Path", icon: "Copy", action: () => copyToClipboard(file.path) });
      items.push({ label: "Copy Relative Path", icon: "Copy", action: () => copyToClipboard(getRelative(file.path)) });
    }
    items.push({
      label: many ? `Delete ${picked.length} items` : "Delete",
      icon: "Trash2", danger: true,
      action: () => askDelete(file)
    });
    return items;
  };

  const headerBtn = "text-text-muted hover:text-text p-1 rounded hover:bg-surface-2";

  return (
    <div className="relative flex flex-col flex-1 min-h-0 text-text overflow-hidden">
      {/* Header. Docked beside a terminal the panel already has a tab bar above, so this
          row drops the workspace name (the tab bar and root header already say it) and
          keeps only the actions — they are the sole way to create a file at the root. */}
      {/* Docked beside a terminal the panel supplies its own tab bar with these very
          actions, so drawing a second strip here would mean two refresh buttons one row
          apart. The host asks for them through onActions instead. */}
      {!compact && (
        <div
          style={{ height: PANEL_HEADER_HEIGHT }}
          className="bg-surface border-b border-border flex items-center gap-2 sticky top-0 z-10 flex-shrink-0 px-3"
        >
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
          {expanded.size > 0 && (
            <button onClick={collapseAll} className={headerBtn} title={t("fileExplorer.collapseAll")}>
              <Icon name="ChevronsDownUp" size={14} />
            </button>
          )}
          <button
            onClick={() => setShowHidden((v) => !v)}
            className={`p-1 rounded hover:bg-surface-2 ${showHidden ? "text-text" : "text-text-muted hover:text-text"}`}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
          >
            <Icon name={showHidden ? "Eye" : "EyeOff"} size={14} />
          </button>
        </div>
      )}

      {/* Tree */}
      <div
        ref={treeRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={`flex-1 overflow-auto py-1 outline-none ${rootDragOver ? "ring-2 ring-inset ring-brand-500/40 bg-brand-500/5" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          const os = hasOsFiles(e);
          e.dataTransfer.dropEffect = os ? "copy" : "move";
          if (os) setRootDragOver(true);
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setRootDragOver(false); }}
        onClick={(e) => { if (e.target === e.currentTarget) { setSelectedPaths(new Set()); setSelectedFolder(null); } }}
        onDrop={(e) => {
          e.preventDefault();
          setRootDragOver(false);
          if (hasOsFiles(e)) { uploadInto(e.dataTransfer, workspace); return; }
          const paths = readDragPaths(e);
          if (paths) moveTo(paths, workspace);
        }}
      >
        {onlyChanged && !rootFiles.some(passesChangedFilter) ? (
          <div className="text-text-subtle text-xs px-3 py-4 text-center">{t("git.noChanges")}</div>
        ) : rootFiles.length === 0 && !loading.has(workspace) ? (
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

      {/* New item modal — the plain name prompt, plus a way in for an OS file picker */}
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
            <div className="flex items-center gap-2 mt-3">
              {/* Uploading an existing folder/file is the other half of "new here", so it
                  sits in this dialog — as one button, not a second mode. */}
              <button
                onClick={() => {
                  vibrate();
                  (newItemModal.type === "folder" && dirPickerOk ? pickFolderRef : pickFilesRef).current?.click();
                }}
                className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-text-muted hover:text-text rounded-brand hover:bg-surface-3"
                title={newItemModal.type === "folder" && dirPickerOk
                  ? "Upload a folder from this computer"
                  : "Upload files from this computer"}
              >
                <Icon name="Upload" size={13} />
                Upload
              </button>
              <div className="flex-1" />
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
          <input ref={pickFilesRef} type="file" multiple className="hidden" onChange={handlePickedFiles} />
          <input ref={pickFolderRef} type="file" webkitdirectory="" className="hidden" onChange={handlePickedFiles} />
        </div>
      )}

      {/* Drop-upload progress + the Skip/Replace prompt it may raise */}
      {upload && (
        <div className="absolute bottom-0 inset-x-0 bg-surface-2 border-t border-border px-3 py-1.5 pb-safe text-[11px] text-text-muted">
          Uploading {Math.min(upload.done + 1, upload.total)}/{upload.total}…
        </div>
      )}
      {uploadConflict && (
        <ConflictModal
          name={uploadConflict.name}
          onResolve={(choice) => { uploadConflict.resolve(choice); setUploadConflict(null); }}
        />
      )}

      {/* Delete confirm */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={runDelete}
        title="Delete"
        message={
          (confirmDelete?.files?.length || 0) > 1
            ? `Are you sure you want to delete these ${confirmDelete.files.length} items?`
            : `Are you sure you want to delete "${confirmDelete?.files?.[0]?.name}"?`
        }
        confirmText="Delete"
        cancelText="Cancel"
      />
    </div>
  );
}
