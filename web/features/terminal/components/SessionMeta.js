"use client";

import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { shortenHomePath } from "../lib/workspaceGrouping";
import { isDefaultBranch } from "../constants/terminalConfig";
import BranchBadge from "./BranchBadge";

// A path outside the workspace (and home) still gets long on a phone — keep the
// last two segments; the full path rides the tooltip.
const tailOf = (p) => (p.split("/").length > 2 ? `…/${p.split("/").slice(-2).join("/")}` : p);

// Second line of a terminal row, shared by the desktop sidebar and the mobile session
// list so the two read as one app. The agent's name is not repeated — the row's icon
// already says which one it is. A default branch (main/master) is the norm, not
// information, so it stays hidden.
export function SessionMeta({ fileBus, cwd, basePath, homeDir }) {
  const { branch, dirty } = useWorkspaceGit(cwd, fileBus);
  const showBranch = !!branch && !isDefaultBranch(branch);
  // Priority order: off-default branch (a worktree) → live folder relative to the
  // workspace root → shortened path when the cwd left the workspace. Parked at the
  // root on the default branch there is nothing to say, so the row stays one line.
  const meta = showBranch ? null
    : cwd && basePath && cwd.startsWith(`${basePath}/`) ? cwd.slice(basePath.length + 1)
    : cwd && basePath && cwd !== basePath ? tailOf(shortenHomePath(cwd, homeDir))
    : null;
  if (!showBranch && !meta) return null;
  return (
    <span className="text-[10px] text-text-subtle truncate leading-tight flex items-center gap-1.5">
      {showBranch && <BranchBadge branch={branch} dirty={dirty} className="truncate italic" />}
      {meta && <span className="truncate opacity-70" data-tip={meta}>{meta}</span>}
    </span>
  );
}

export default SessionMeta;
