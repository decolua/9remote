"use client";

import Icon from "@/shared/components/ui/Icon";
import { GIT_STATUS_COLORS } from "../constants/fileExplorer.js";
import { resolveFileIcon, resolveFolderIcon } from "../constants/fileIcons.js";

const INDENT_BASE = 12;
const INDENT_STEP = 12;
const TRUNCATED_NOTE = "Showing first 300 entries — use search for the rest.";

export const indentFor = (depth) => INDENT_BASE + depth * INDENT_STEP;

/** Git badge: a dot for "contains changes", the status letters otherwise. */
function GitBadge({ status }) {
  if (!status) return null;
  if (status === "folder-changed") {
    return <span className="w-1.5 h-1.5 rounded-full bg-blue-400/70 mr-1" />;
  }
  return <span className={`text-[11px] font-bold ${GIT_STATUS_COLORS[status] || "text-text-muted"} ml-1`}>{status}</span>;
}

const nameColor = (status) => {
  if (status === "folder-changed") return "text-yellow-400";
  return GIT_STATUS_COLORS[status] || "";
};

export function TruncatedNote({ depth }) {
  return (
    <div className="text-[11px] text-text-muted italic py-0.5 pr-2" style={{ paddingLeft: indentFor(depth) }}>
      {TRUNCATED_NOTE}
    </div>
  );
}

// One row of the desktop file tree: expander, icon, name (or rename input),
// git badge and the overflow button. Recursion lives in the parent.
// Extracted verbatim from ExplorerPanel.renderRow.
export default function ExplorerRow({
  file, depth, isFolder, isExpanded, isLoading, isActive, isSelected, isRenaming, isDragOver,
  gitStatus, renameValue, renameInputRef,
  onRenameChange, onRenameSubmit, onRenameCancel,
  onToggleFolder, onClick, onContextMenu, onTouchStart, onTouchEnd,
  onDragStart, onDragOver, onDragLeave, onDrop,
  children
}) {
  return (
    <div>
      <div
        draggable={!isRenaming}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`group flex items-center gap-1 pr-2 py-0.5 cursor-pointer select-none text-sm ${
          isDragOver ? "bg-brand-500/30 ring-1 ring-brand-500" :
          isActive || isSelected ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
        style={{ paddingLeft: indentFor(depth) }}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchEnd}
        onClick={(e) => !isRenaming && onClick(e)}
      >
        {isFolder ? (
          <span
            onClick={(e) => { e.stopPropagation(); onToggleFolder(); }}
            className="flex items-center justify-center w-4 h-4 text-text-muted"
          >
            {isLoading ? (
              <Icon name="Loader2" size={12} className="animate-spin" />
            ) : isExpanded ? (
              <Icon name="ChevronDown" size={14} />
            ) : (
              <Icon name="ChevronRight" size={14} />
            )}
          </span>
        ) : (
          <span className="w-4 h-4" />
        )}

        <span className="shrink-0">
          {isFolder ? resolveFolderIcon(file.name, isExpanded, 16) : resolveFileIcon(file, 16)}
        </span>

        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSubmit();
              else if (e.key === "Escape") onRenameCancel();
            }}
            className="flex-1 bg-surface-3 text-text text-sm px-1 py-0.5 rounded outline-none border border-brand-500"
          />
        ) : (
          <span className={`flex-1 truncate text-text ${nameColor(gitStatus)}`}>{file.name}</span>
        )}

        {!isRenaming && <GitBadge status={gitStatus} />}

        {!isRenaming && (
          <button
            onClick={onContextMenu}
            className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-text px-1"
          >
            <Icon name="MoreHorizontal" size={14} />
          </button>
        )}
      </div>

      {children}
    </div>
  );
}
