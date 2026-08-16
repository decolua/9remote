"use client";

import { useCallback, useEffect, useState } from "react";
import { REPO_SCAN } from "../constants/terminalConfig";

// Repos found at or under a workspace root. The agent memoizes the disk walk; this hook
// only holds the result and exposes an explicit refresh, so switching tabs never rescans.
export function useWorkspaceRepos(rootPath, fileSocket) {
  const [repos, setRepos] = useState([]);
  const [scanning, setScanning] = useState(false);
  // Off by default: a workspace sitting above a pile of reference clones should not list
  // them. Monorepos whose real repos live at packages/*/ turn this on.
  const [deep, setDeep] = useState(false);

  const scan = useCallback(async (force, deepScan) => {
    if (!rootPath || !fileSocket?.gitScanRepos) return;
    setScanning(true);
    if (force) await fileSocket.gitRefreshRepos?.(rootPath);
    const depth = deepScan ? REPO_SCAN.deepMaxDepth : REPO_SCAN.maxDepth;
    const res = await fileSocket.gitScanRepos(rootPath, depth);
    setScanning(false);
    setRepos(res?.success ? res.repos || [] : []);
  }, [rootPath, fileSocket]);

  // Deferred: the scan flips `scanning` immediately, which must not run synchronously
  // inside the effect body.
  useEffect(() => {
    const id = setTimeout(() => void scan(false, deep), 0);
    return () => clearTimeout(id);
  }, [scan, deep]);

  const refresh = useCallback(() => scan(true, deep), [scan, deep]);
  const scanDeeper = useCallback(() => setDeep(true), []);

  return { repos, refresh, scanning, deep, scanDeeper };
}
