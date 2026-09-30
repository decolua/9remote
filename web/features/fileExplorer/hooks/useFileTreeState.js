"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { STORAGE_KEYS, GIT_REFRESH_EVENT } from "../constants/fileExplorer.js";
import { useDirWatch, usePageVisible } from "./useDirWatch";
import { buildWorkspaceGitStatus } from "@/features/fileExplorer/lib/gitStatusMap";
import { vibrate } from "@/shared/utils/vibration";

// Lazy directory cache for the desktop tree: which dirs are loaded, which are
// expanded (persisted), which are still loading or truncated, plus git badges.
// Extracted verbatim from ExplorerPanel.

// Coalesce bursts of file-change events into one git status build.
const GIT_STATUS_DEBOUNCE_MS = 300;

// Initial root load retries with backoff up to this delay (~31s total) — the
// panel mounts before the bus exists on a cold load, and without a retry the
// "Empty workspace" placeholder sticks until the user remounts the panel.
const ROOT_LOAD_RETRY_MAX_MS = 16000;

// Expanded folders are stored per workspace: one shared list meant opening a second
// workspace overwrote the first one's, so going back always found the tree collapsed.
function readExpandedStore() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.expandedFolders);
    const parsed = raw ? JSON.parse(raw) : {};
    // Migrate the old flat array: it belonged to whichever workspace was last open, and
    // the startsWith filter below drops the paths that do not fit the current one.
    return Array.isArray(parsed) ? { legacy: parsed } : parsed;
  } catch {
    return {};
  }
}

function loadExpanded(workspace) {
  const store = readExpandedStore();
  const own = store[workspace];
  if (Array.isArray(own)) return own;
  return Array.isArray(store.legacy) ? store.legacy : [];
}

function saveExpanded(workspace, set) {
  if (typeof window === "undefined" || !workspace) return;
  try {
    const store = readExpandedStore();
    delete store.legacy;
    store[workspace] = [...set];
    window.localStorage.setItem(STORAGE_KEYS.expandedFolders, JSON.stringify(store));
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

export function useFileTreeState({ workspace, fileBus }) {
  const [tree, setTree] = useState(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set());
  // Which workspace `expanded` currently describes — see the persist effect below.
  const [expandedFor, setExpandedFor] = useState(null);
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
      const res = await fileBus.getFiles(dirPath, showHidden);
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
      return null; // failed request — lets the caller distinguish from an empty dir
    },
    [fileBus, showHidden]
  );

  // Load git status and propagate folder-changed up parents. A workspace that is a
  // parent folder of nested repos gets every repo's status merged in.
  const gitSeqRef = useRef(0);
  // Sequence-stamped so a slow earlier build (workspace switch, event burst) never overwrites a newer one.
  const loadGitStatus = useCallback(async () => {
    if (!workspace) return;
    const seq = ++gitSeqRef.current;
    const { map } = await buildWorkspaceGitStatus(fileBus, workspace);
    if (seq === gitSeqRef.current) setGitStatusMap(map);
  }, [fileBus, workspace]);

  // Initial mount: load workspace root + restore expanded + git status
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    let retryTimer = null;
    let delay = 1000;
    const persisted = loadExpanded(workspace);
    const restored = new Set([workspace]);
    // Restore previously-expanded subpaths in parallel — sequential awaits waterfall one round-trip per folder.
    const wanted = persisted.filter((p) => typeof p === "string" && p.startsWith(workspace));
    for (const p of wanted) restored.add(p);
    const load = async () => {
      const [root] = await Promise.all([loadDir(workspace), ...wanted.map((p) => loadDir(p))]);
      if (!alive) return;
      if (root == null && delay <= ROOT_LOAD_RETRY_MAX_MS) {
        const wait = delay;
        delay *= 2;
        retryTimer = setTimeout(load, wait);
        return;
      }
      setExpanded(restored);
      setExpandedFor(workspace);
      loadGitStatus();
    };
    load();
    return () => {
      alive = false;
      clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // Refresh git badges when files saved/changed elsewhere — debounced so bursts of
  // file events coalesce into one status build.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer = null;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(loadGitStatus, GIT_STATUS_DEBOUNCE_MS);
    };
    const events = ["fileExplorer:fileSaved", "fileExplorer:fileCreated", "fileExplorer:fileDeleted", "fileExplorer:fileRenamed", GIT_REFRESH_EVENT];
    events.forEach(ev => window.addEventListener(ev, handler));
    return () => {
      clearTimeout(timer);
      events.forEach(ev => window.removeEventListener(ev, handler));
    };
  }, [loadGitStatus]);

  // Persist expanded. Keyed by the workspace the set was built for, not the current one:
  // on a workspace switch this effect runs before the restore above has replaced the set,
  // and writing it unkeyed would stamp the old workspace's folders onto the new one.
  useEffect(() => {
    if (expandedFor !== workspace) return;
    saveExpanded(workspace, expanded);
  }, [workspace, expandedFor, expanded]);

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

  const collapseAll = useCallback(() => {
    vibrate();
    setExpanded(new Set());
  }, []);

  // Live updates: the tree follows the disk instead of waiting for the refresh button.
  // Only loaded directories are watched, and only while the tab is in front.
  const visible = usePageVisible();
  // Loaded but collapsed directories stay in the cache; watching them would spend the
  // user's machine on rows that are not even on screen. Only what is open counts.
  const watchedDirs = useMemo(
    () => [...tree.keys()].filter((d) => d === workspace || expanded.has(d)),
    [tree, expanded, workspace]
  );
  const reloadDirs = useCallback((dirs) => {
    Promise.all(dirs.map((d) => loadDir(d))).catch(() => {});
    loadGitStatus();
  }, [loadDir, loadGitStatus]);

  useDirWatch({ dirs: watchedDirs, fileBus, onDirsChanged: reloadDirs, enabled: visible });

  // Events that arrived while the tab was hidden are gone, so the tree is reloaded once
  // on return. Skipped on the first render — the mount effect above already loaded it.
  const wasVisibleRef = useRef(true);
  useEffect(() => {
    const came = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (came && tree.size) reloadDirs([...tree.keys()]);
    // tree is read on the transition only; depending on it would reload on every load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const refreshAll = useCallback(async () => {
    vibrate();
    const dirs = [...tree.keys()];
    await Promise.all(dirs.map((d) => loadDir(d)));
    loadGitStatus();
  }, [tree, loadDir, loadGitStatus]);

  return {
    tree, expanded, loading, truncatedDirs, gitStatusMap,
    showHidden, setShowHidden,
    loadDir, loadGitStatus, toggleFolder, expandDir, collapseAll, refreshAll
  };
}
