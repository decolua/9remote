"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { EDITOR_PANEL_WIDTH } from "../constants/terminalConfig";
import { resolveFileIcon } from "@/features/fileExplorer/constants/fileIcons";
import { isDiffPath, parseRepoDiffPath, makeDiffPath, GIT_STATUS_COLORS } from "@/features/fileExplorer/constants/fileExplorer";

const EmbeddedEditor = dynamic(() => import("@/features/fileExplorer/components/EmbeddedEditor"), { ssr: false });
const DiffView = dynamic(() => import("@/features/fileExplorer/components/DiffView"), { ssr: false });

// A file opened from the tree, edited without leaving the terminal. Narrow on purpose —
// this is for a quick read or fix, not a replacement for the full editor view.
export default function TerminalEditorPanel({
  filePath, workspace, fileSocket, width, onResize, onClose, isDesktop = true
}) {
  // Stamped with the file it belongs to: switching files must not carry the previous
  // file's unsaved marker over, which would also wrongly block Escape.
  const [dirtyState, setDirtyState] = useState({ forFile: null, dirty: false });
  const dirty = dirtyState.forFile === filePath && dirtyState.dirty;
  const setDirty = (value) => setDirtyState({ forFile: filePath, dirty: value });

  // Escape closes, unless there are unsaved edits — losing them to a stray key is worse
  // than one extra click.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !dirty) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  if (!filePath) return null;

  // The Git tab opens a file as a "git-diff:…" tab id, not a path on disk — reading it as
  // one is what produced "file not found". It also carries the repo the path belongs to,
  // since the panel lists nested repos and worktrees alongside the workspace root.
  const isDiff = isDiffPath(filePath);
  const diff = isDiff ? parseRepoDiffPath(filePath) : null;
  const diffRepo = diff?.repoPath || workspace;
  const displayPath = isDiff ? diff.filePath : filePath;

  const name = displayPath.split("/").pop();
  // Path relative to its own repo reads better than the absolute one in a tooltip.
  const relPath = workspace && displayPath.startsWith(workspace)
    ? displayPath.slice(workspace.length).replace(/^\//, "")
    : displayPath;

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => onResize?.(startW - (ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="h-full flex flex-col bg-bg border-l border-border-subtle relative shrink min-w-0"
      style={isDesktop ? { width, flexBasis: width, minWidth: EDITOR_PANEL_WIDTH.min } : undefined}
    >
      <div style={{ height: PANEL_HEADER_HEIGHT }}
        className="px-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0">
        <span className="flex-shrink-0">{resolveFileIcon({ name, type: "file" }, 14)}</span>
        <span className="flex-1 min-w-0 truncate text-[12px] text-text" title={relPath}>{name}</span>
        {isDiff && (
          <span className={`text-[10px] font-bold flex-shrink-0 ${GIT_STATUS_COLORS[diff.status] || "text-text-muted"}`}>
            {diff.status}
          </span>
        )}
        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-text-muted flex-shrink-0" title={relPath} />}
        <button
          onClick={() => { vibrate(); onClose(); }}
          className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isDiff ? (
          <DiffView diffPath={makeDiffPath(diff.status, diff.filePath)} workspace={diffRepo} fileSocket={fileSocket} />
        ) : (
          <EmbeddedEditor
            filePath={filePath}
            fileSocket={fileSocket}
            workspace={workspace}
            onDirtyChange={setDirty}
            compact
          />
        )}
      </div>

      {isDesktop && (
        <div
          onPointerDown={startResize}
          className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
        />
      )}
    </div>
  );
}
