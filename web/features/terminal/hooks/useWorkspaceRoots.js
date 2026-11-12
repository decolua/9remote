"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestWithBusRetry } from "../lib/busRetry";
import { useFileBusStore } from "@/shared/stores/fileBusStore";

// Roots the file tree shows: the workspace plus each of its worktrees. They are separate
// directories on disk, so one tree cannot contain them — each gets its own root section.
export function useWorkspaceRoots(workspacePath, propFileBus) {
  const [roots, setRoots] = useState([]);
  const fileBus = propFileBus || useFileBusStore.getState();

  // Sequence-stamped so a slow retry from a previous workspace cannot overwrite the current roots.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!workspacePath || !fileBus?.gitWorktreeList) return setRoots([]);
    const seq = ++seqRef.current;
    const res = await requestWithBusRetry(
      () => fileBus.gitWorktreeList(workspacePath),
      () => seqRef.current === seq
    );
    if (seqRef.current !== seq) return;
    if (!res?.success || !res.worktrees?.length) {
      // Not a repo, or git unavailable — the workspace folder is still a valid root.
      return setRoots([{ path: workspacePath, branch: null, name: basename(workspacePath) }]);
    }
    setRoots(res.worktrees.map((wt) => ({
      path: wt.path,
      branch: wt.branch,
      name: basename(wt.path),
      isMain: wt.isMain
    })));
  }, [workspacePath, fileBus]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    // Abandons an in-flight retry loop so it cannot land on a later mount or workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the live value is the point
    return () => { clearTimeout(id); seqRef.current++; };
  }, [load]);

  return { roots, refresh: load };
}

const basename = (p) => (p || "").split("/").filter(Boolean).pop() || p;
