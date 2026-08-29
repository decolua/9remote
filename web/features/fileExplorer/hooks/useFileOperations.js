"use client";

import { useCallback } from "react";
import { joinPath, dirname, basename } from "@/features/fileExplorer/lib/pathUtils";

const CHANGE_EVENTS = {
  created: "fileExplorer:fileCreated",
  deleted: "fileExplorer:fileDeleted",
  renamed: "fileExplorer:fileRenamed"
};

// Broadcast so the git badges (and any other listener) refresh after a mutation.
function notify(kind) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENTS[kind]));
}

// File mutations for the desktop tree: create, rename, delete, duplicate, move.
// Each one refreshes the affected directory and announces the change.
// Extracted verbatim from ExplorerPanel.
export function useFileOperations({ fileBus, loadDir, loadGitStatus, expandDir, onOpenFile, onMoved }) {
  const createItem = useCallback(async (dir, name, type) => {
    const itemPath = joinPath(dir, name);
    const res = await fileBus.createItem(itemPath, type);
    if (!res?.success) return;
    notify("created");
    await loadDir(dir);
    if (type === "folder") expandDir(dir);
    else onOpenFile?.(itemPath);
  }, [fileBus, loadDir, expandDir, onOpenFile]);

  const renameItem = useCallback(async (file, newName) => {
    const parent = dirname(file.path);
    const newPath = joinPath(parent, newName);
    const res = await fileBus.renameItem(file.path, newPath);
    if (!res?.success) return;
    notify("renamed");
    await loadDir(parent);
  }, [fileBus, loadDir]);

  const deleteItem = useCallback(async (file) => {
    const parent = dirname(file.path);
    const res = await fileBus.deleteItem(file.path);
    if (!res?.success) return;
    notify("deleted");
    await loadDir(parent);
  }, [fileBus, loadDir]);

  const deleteMany = useCallback(async (files) => {
    if (!files?.length) return;
    const dirs = new Set();
    for (const file of files) {
      const res = await fileBus.deleteItem(file.path);
      if (res?.success) dirs.add(dirname(file.path));
    }
    if (!dirs.size) return;
    notify("deleted");
    for (const d of dirs) await loadDir(d);
    loadGitStatus();
    onMoved?.();
  }, [fileBus, loadDir, loadGitStatus, onMoved]);

  // Copy `src` into `dir`, stepping the name aside when it is taken ("x copy", "x copy 2").
  const copyInto = useCallback(async (src, dir) => {
    const name = basename(src);
    const existing = new Set(((await fileBus.getFiles(dir, true))?.files || []).map((f) => f.name));
    let candidate = name;
    if (existing.has(candidate)) {
      const dotIdx = name.lastIndexOf(".");
      const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      candidate = `${stem} copy${ext}`;
      for (let n = 2; existing.has(candidate); n++) candidate = `${stem} copy ${n}${ext}`;
    }
    return fileBus.copyItem(src, joinPath(dir, candidate));
  }, [fileBus]);

  const duplicateItem = useCallback(async (file) => {
    const parent = dirname(file.path);
    const res = await copyInto(file.path, parent);
    if (!res?.success) return;
    notify("created");
    await loadDir(parent);
    loadGitStatus();
  }, [copyInto, loadDir, loadGitStatus]);

  // Move files via drag-drop (uses renameItem as move)
  const moveTo = useCallback(async (paths, targetDir) => {
    if (!paths?.length || !targetDir) return;
    for (const src of paths) {
      const name = src.split("/").pop();
      const dest = joinPath(targetDir, name);
      // Skip a no-op move and any attempt to drop a folder inside itself.
      if (src === dest || dest.startsWith(src + "/")) continue;
      await fileBus.renameItem(src, dest);
    }
    // Refresh affected dirs
    const dirs = new Set([targetDir, ...paths.map((p) => dirname(p))]);
    for (const d of dirs) await loadDir(d);
    notify("renamed");
    loadGitStatus();
    onMoved?.();
  }, [fileBus, loadDir, loadGitStatus, onMoved]);

  // Paste an internal clipboard into a folder: "cut" is a move, "copy" duplicates.
  const pasteInto = useCallback(async (paths, targetDir, mode) => {
    if (!paths?.length || !targetDir) return;
    if (mode === "cut") return moveTo(paths, targetDir);
    let copied = 0;
    for (const src of paths) {
      if (targetDir === src || targetDir.startsWith(src + "/")) continue;
      const res = await copyInto(src, targetDir);
      if (res?.success) copied++;
    }
    if (!copied) return;
    notify("created");
    await loadDir(targetDir);
    expandDir(targetDir);
    loadGitStatus();
  }, [copyInto, moveTo, loadDir, expandDir, loadGitStatus]);

  return { createItem, renameItem, deleteItem, deleteMany, duplicateItem, moveTo, pasteInto };
}
