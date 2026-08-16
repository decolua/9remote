"use client";

import { useCallback, useEffect, useState } from "react";

// Roots the file tree shows: the workspace plus each of its worktrees. They are separate
// directories on disk, so one tree cannot contain them — each gets its own root section.
export function useWorkspaceRoots(workspacePath, fileSocket) {
  const [roots, setRoots] = useState([]);

  const load = useCallback(async () => {
    if (!workspacePath || !fileSocket?.gitWorktreeList) return setRoots([]);
    const res = await fileSocket.gitWorktreeList(workspacePath);
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
  }, [workspacePath, fileSocket]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  return { roots, refresh: load };
}

const basename = (p) => (p || "").split("/").filter(Boolean).pop() || p;
