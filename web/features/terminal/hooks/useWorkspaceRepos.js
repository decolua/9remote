"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REPO_SCAN } from "../constants/terminalConfig";
import { requestWithBusRetry } from "../lib/busRetry";
import { useFileBusStore } from "@/shared/stores/fileBusStore";

// Repos found at or under a workspace root. The agent memoizes the disk walk; this hook
// only holds the result and exposes an explicit refresh, so switching tabs never rescans.
export function useWorkspaceRepos(rootPath, propFileBus) {
  const [repos, setRepos] = useState([]);
  const [scanning, setScanning] = useState(false);
  const fileBus = propFileBus || useFileBusStore.getState();
  // Off by default: a workspace sitting above a pile of reference clones should not list
  // them. Monorepos whose real repos live at packages/*/ turn this on.
  const [deep, setDeep] = useState(false);

  // Sequence-stamped so a slow retry from a previous root cannot overwrite the current scan.
  const seqRef = useRef(0);

  const scan = useCallback(async (force, deepScan) => {
    if (!rootPath || !fileBus?.gitScanRepos) return;
    const seq = ++seqRef.current;
    setScanning(true);
    if (force) await fileBus.gitRefreshRepos?.(rootPath);
    const depth = deepScan ? REPO_SCAN.deepMaxDepth : REPO_SCAN.maxDepth;
    const res = await requestWithBusRetry(
      () => fileBus.gitScanRepos(rootPath, depth, force),
      () => seqRef.current === seq
    );
    if (seqRef.current !== seq) return;
    setScanning(false);
    setRepos(res?.success ? res.repos || [] : []);
  }, [rootPath, fileBus]);

  // Deferred: the scan flips `scanning` immediately, which must not run synchronously
  // inside the effect body.
  useEffect(() => {
    const id = setTimeout(() => void scan(false, deep), 0);
    // Abandons an in-flight retry loop so it cannot land on a later mount or root.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the live value is the point
    return () => { clearTimeout(id); seqRef.current++; };
  }, [scan, deep]);

  const refresh = useCallback(() => scan(true, deep), [scan, deep]);
  const scanDeeper = useCallback(() => setDeep(true), []);

  return { repos, refresh, scanning, deep, scanDeeper };
}
