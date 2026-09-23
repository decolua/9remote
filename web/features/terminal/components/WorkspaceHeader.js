"use client";

import { ChevronRight, Folder, Pencil, Plus, Trash2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import IconMenu from "@/shared/components/ui/IconMenu";
import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { workspaceGitPath } from "../lib/workspaceGrouping";
import { isDefaultBranch } from "../constants/terminalConfig";
import BranchBadge from "./BranchBadge";

// Hidden until the row is hovered on pointer devices; dimmed but visible on touch.
// The row must carry the plain `group` class for this to fire. Shared by the
// sidebar's trees — the main host's and every other host's.
export const REVEAL_CLS = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity";

// One workspace folder row: chevron + folder + name (+ off-default branch badge)
// and the new-terminal / rename / delete actions a caller wires. Null callbacks
// hide their action, so a read-only tree (another host's) renders the same shape.
export default function WorkspaceHeader({
  workspace, isActive, connected, collapsed, fileBus,
  onToggleCollapse, onSelect, onNewTerminal, onDelete, onRename
}) {
  const { t } = useI18n();
  const gitPath = workspaceGitPath(workspace);
  // No fileBus (another host's tree) must NOT fall back to the main host's bus —
  // that would scan this workspace's path on the wrong machine.
  const { branch, dirty } = useWorkspaceGit(gitPath, fileBus, { enabled: !!fileBus });

  return (
    <div
      onClick={onSelect}
      className={`relative pr-2 py-1.5 flex items-center gap-1 group group/grp transition-colors ${
        onSelect ? "cursor-pointer hover:bg-text/[0.06]" : ""
      }`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); vibrate(); onToggleCollapse?.(); }}
        className="p-1 text-text-subtle hover:text-text flex-shrink-0"
        tabIndex={-1}
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`} />
      </button>
      <Folder size={13.5} className="text-text-muted flex-shrink-0" />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={`text-[12px] font-medium uppercase truncate ${isActive ? "text-text" : "text-text-muted"}`} data-tip={workspace.name}>
          {workspace.name}
        </span>
        {/* Path is dropped and a default branch stays hidden — only an off-default
            worktree is worth a second line. Never repeats the workspace name. */}
        {branch && !isDefaultBranch(branch) && branch !== workspace.name && (
          <span className="text-[10px] text-text-subtle leading-tight flex items-center gap-1 min-w-0">
            <BranchBadge branch={branch} dirty={dirty} className="truncate flex-shrink-0 max-w-[7rem]" />
          </span>
        )}
      </span>
      {/* New terminal (+) and "..." — the ExplorerRow door: name runs full width,
          hover floats the cluster over its end with a surface backdrop. */}
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
        {onNewTerminal && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); vibrate(); onNewTerminal(); }}
            disabled={!connected}
            className="p-0.5 text-text-subtle hover:text-text rounded-[2px] transition-colors disabled:opacity-40"
            title={t("terminal.newTerminal")}
          >
            <Plus size={13.5} />
          </button>
        )}
        <IconMenu
          size={13.5}
          label={t("sessions.sessionActions")}
          revealCls=""
          items={[
            onRename && {
              icon: Pencil, label: t("workspaces.rename"),
              onClick: () => onRename()
            },
            onDelete && connected && {
              icon: Trash2, label: t("workspaces.delete"), danger: true,
              onClick: () => onDelete()
            }
          ]}
        />
      </div>
    </div>
  );
}
