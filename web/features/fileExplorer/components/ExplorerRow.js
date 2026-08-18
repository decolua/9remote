"use client";

import Icon from "@/shared/components/ui/Icon";
import { GIT_STATUS_COLORS, EXPLORER_ROW } from "../constants/fileExplorer.js";
import { resolveFileIcon, resolveFolderIcon } from "../constants/fileIcons.js";

const TRUNCATED_NOTE = "Showing first 300 entries — use search for the rest.";

export const metricsFor = (compact) => (compact ? EXPLORER_ROW.compact : EXPLORER_ROW.normal);

export const indentFor = (depth, compact = false) => {
  const m = metricsFor(compact);
  return m.indentBase + depth * m.indentStep;
};

/** Git badge, right-aligned: a dot for "contains changes", the status letters otherwise. */
function GitBadge({ status }) {
  if (!status) return null;
  if (status === "folder-changed") {
    return <span className="ml-auto mr-2 w-1.5 h-1.5 rounded-full bg-blue-400/70" />;
  }
  return <span className={`ml-auto mr-2 text-[10px] font-semibold ${GIT_STATUS_COLORS[status] || "text-text-muted"}`}>{status}</span>;
}

const nameColor = (status) => GIT_STATUS_COLORS[status] || "";

export function TruncatedNote({ depth, compact = false }) {
  return (
    <div className="text-[11px] text-text-muted italic py-0.5 pr-2" style={{ paddingLeft: indentFor(depth, compact) }}>
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
  compact = false,
  children
}) {
  const m = metricsFor(compact);
  return (
    <div>
      <div
        data-path={file.path}
        draggable={!isRenaming}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`group relative flex items-center gap-1 rounded-[3px] mx-0.5 pr-2 cursor-pointer select-none ${m.text} ${m.padY} ${
          isDragOver ? "bg-brand-500/30 ring-1 ring-brand-500" :
          isActive ? "bg-brand-500/15" :
          isSelected ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
        style={{ paddingLeft: indentFor(depth, compact) }}
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
              <Icon name="Loader2" size={m.chevron - 2} className="animate-spin" />
            ) : (
              <Icon
                name="ChevronRight"
                size={m.chevron}
                className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
              />
            )}
          </span>
        ) : (
          <span className="w-4 h-4" />
        )}

        <span className="shrink-0">
          {isFolder ? resolveFolderIcon(file.name, isExpanded, m.icon) : resolveFileIcon(file, m.icon)}
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
            className={`flex-1 bg-surface-3 text-text ${m.text} px-1 py-0.5 rounded outline-none border border-brand-500`}
          />
        ) : (
          <span className={`flex-1 truncate text-text ${nameColor(gitStatus)}`}>{file.name}</span>
        )}

        {!isRenaming && <GitBadge status={gitStatus} />}

        {/* Overflow floats OVER the name (git-panel style, no reserved space) — the
            terminal action moved into the context menu. */}
        {!isRenaming && (
          <div className="absolute right-[26px] top-1/2 -translate-y-1/2 flex items-center pl-2 pr-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={onContextMenu}
              className="p-0.5 text-text-muted hover:text-text"
            >
              <Icon name="MoreHorizontal" size={m.chevron} />
            </button>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}
