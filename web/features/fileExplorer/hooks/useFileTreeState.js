"use client";

import { useState, useCallback, useEffect } from "react";
import { STORAGE_KEYS } from "../constants/fileExplorer.js";
import { buildGitStatusMap } from "@/features/fileExplorer/lib/gitStatusMap";
import { vibrate } from "@/shared/utils/vibration";

// Lazy directory cache for the desktop tree: which dirs are loaded, which are
// expanded (persisted), which are still loading or truncated, plus git badges.
// Extracted verbatim from ExplorerPanel.

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

function readShowHidden() {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.showHidden);
    if (raw === null) return true;
    return JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

export function useFileTreeState({ workspace, fileSocket }) {
  const [tree, setTree] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  const [loading, setLoading] = useState(() => new Set());
  const [truncatedDirs, setTruncatedDirs] = useState(() => new Set());
  const [gitStatusMap, setGitStatusMap] = useState({});
  const [showHidden, setShowHidden] = useState(readShowHidden);

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
        setTruncatedDirs((prev) => {
          const has = Boolean(res.truncated);
          if (has === prev.has(dirPath)) return prev;
          const next = new Set(prev);
          has ? next.add(dirPath) : next.delete(dirPath);
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
    setGitStatusMap(buildGitStatusMap(res));
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

  // Persist + reload cached dirs when toggle hidden files
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.showHidden, JSON.stringify(showHidden));
    if (tree.size > 0) {
      const dirs = [...tree.keys()];
      Promise.all(dirs.map((d) => loadDir(d))).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

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

  const expandDir = useCallback((dir) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(dir);
      return next;
    });
  }, []);

  const refreshAll = useCallback(async () => {
    vibrate();
    const dirs = [...tree.keys()];
    await Promise.all(dirs.map((d) => loadDir(d)));
    loadGitStatus();
  }, [tree, loadDir, loadGitStatus]);

  return {
    tree, expanded, loading, truncatedDirs, gitStatusMap,
    showHidden, setShowHidden,
    loadDir, loadGitStatus, toggleFolder, expandDir, refreshAll
  };
}
