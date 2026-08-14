"use client";

import { useCallback } from "react";
import { joinPath, dirname } from "@/features/fileExplorer/lib/pathUtils";

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
export function useFileOperations({ fileSocket, loadDir, loadGitStatus, expandDir, onOpenFile, onMoved }) {
  const createItem = useCallback(async (dir, name, type) => {
    const itemPath = joinPath(dir, name);
    const res = await fileSocket.createItem(itemPath, type);
    if (!res?.success) return;
    notify("created");
    await loadDir(dir);
    if (type === "folder") expandDir(dir);
    else onOpenFile?.(itemPath);
  }, [fileSocket, loadDir, expandDir, onOpenFile]);

  const renameItem = useCallback(async (file, newName) => {
    const parent = dirname(file.path);
    const newPath = joinPath(parent, newName);
    const res = await fileSocket.renameItem(file.path, newPath);
    if (!res?.success) return;
    notify("renamed");
    await loadDir(parent);
  }, [fileSocket, loadDir]);

  const deleteItem = useCallback(async (file) => {
    const parent = dirname(file.path);
    const res = await fileSocket.deleteItem(file.path);
    if (!res?.success) return;
    notify("deleted");
    await loadDir(parent);
  }, [fileSocket, loadDir]);

  const duplicateItem = useCallback(async (file) => {
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
  }, [fileSocket, loadDir]);

  // Move files via drag-drop (uses renameItem as move)
  const moveTo = useCallback(async (paths, targetDir) => {
    if (!paths?.length || !targetDir) return;
    for (const src of paths) {
      const name = src.split("/").pop();
      const dest = joinPath(targetDir, name);
      // Skip a no-op move and any attempt to drop a folder inside itself.
      if (src === dest || dest.startsWith(src + "/")) continue;
      await fileSocket.renameItem(src, dest);
    }
    // Refresh affected dirs
    const dirs = new Set([targetDir, ...paths.map((p) => dirname(p))]);
    for (const d of dirs) await loadDir(d);
    notify("renamed");
    loadGitStatus();
    onMoved?.();
  }, [fileSocket, loadDir, loadGitStatus, onMoved]);

  return { createItem, renameItem, deleteItem, duplicateItem, moveTo };
}
