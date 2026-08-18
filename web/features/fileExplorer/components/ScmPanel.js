"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus, RefreshCw, X, ExternalLink } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import FileContextMenu from "@/shared/components/ui/FileContextMenu";
import { GIT_STATUS_COLORS, makeDiffPath, makeRepoDiffPath } from "../constants/fileExplorer.js";
import { resolveFileIcon } from "../constants/fileIcons.js";

const SECTION_CHANGES = "changes";
const SECTION_UNTRACKED = "untracked";

function basename(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

function joinPath(base, rel) {
  if (!base) return rel;
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}${rel}`;
}

export default function ScmPanel({ workspace, fileSocket, onOpenFile, tagDiffWithRepo = false }) {
  const [branch, setBranch] = useState("");
  const [ahead, setAhead] = useState(null);
  const [behind, setBehind] = useState(null);
  const [files, setFiles] = useState([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedSections, setExpandedSections] = useState(new Set([SECTION_CHANGES, SECTION_UNTRACKED]));
  const [confirmAutoStageOpen, setConfirmAutoStageOpen] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState(null);

  const reload = useCallback(async () => {
    if (!workspace || !fileSocket) return;
    setLoading(true);
    const [statusRes, branchRes] = await Promise.all([
      fileSocket.gitStatus?.(workspace),
      fileSocket.gitBranch?.(workspace)
    ]);
    setLoading(false);
    if (statusRes?.success) setFiles(statusRes.files || []);
    if (branchRes?.success) {
      setBranch(branchRes.branch || "");
      setAhead(branchRes.ahead ?? null);
      setBehind(branchRes.behind ?? null);
    }
  }, [workspace, fileSocket]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-refresh when files saved/created/deleted/renamed elsewhere
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => reload();
    const events = ["fileExplorer:fileSaved", "fileExplorer:fileCreated", "fileExplorer:fileDeleted", "fileExplorer:fileRenamed"];
    events.forEach(ev => window.addEventListener(ev, handler));
    return () => events.forEach(ev => window.removeEventListener(ev, handler));
  }, [reload]);

  const { changes, untracked } = useMemo(() => {
    const ch = [];
    const un = [];
    for (const f of files) {
      if (f.status === "?") un.push(f); else ch.push(f);
    }
    return { changes: ch, untracked: un };
  }, [files]);

  const toggleSection = useCallback((id) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const stageFile = useCallback(async (file) => {
    if (!workspace) return;
    await fileSocket.gitAdd?.(workspace, [file.path]);
    reload();
  }, [workspace, fileSocket, reload]);

  const stageAll = useCallback(async () => {
    if (!workspace) return;
    await fileSocket.gitAdd?.(workspace, ["."]);
    reload();
  }, [workspace, fileSocket, reload]);

  const discardFile = useCallback(async (file) => {
    if (!workspace) return;
    await fileSocket.gitDiscard?.(workspace, file.path, file.status);
    reload();
  }, [workspace, fileSocket, reload]);

  const requestDiscard = useCallback((file) => {
    setDiscardTarget(file);
    setConfirmDiscardOpen(true);
  }, []);

  const doCommit = useCallback(async () => {
    if (!workspace || !commitMsg.trim()) return;
    await fileSocket.gitCommit?.(workspace, commitMsg.trim());
    setCommitMsg("");
    reload();
  }, [workspace, fileSocket, commitMsg, reload]);

  const handleCommitClick = useCallback(() => {
    if (!commitMsg.trim()) return;
    if (!files.length) return;
    setConfirmAutoStageOpen(true);
  }, [commitMsg, files]);

  const confirmAutoStageAndCommit = useCallback(async () => {
    if (!workspace) return;
    await fileSocket.gitAdd?.(workspace, ["."]);
    await fileSocket.gitCommit?.(workspace, commitMsg.trim());
    setCommitMsg("");
    reload();
  }, [workspace, fileSocket, commitMsg, reload]);

  const handlePush = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    await fileSocket.gitPush?.(workspace);
    setLoading(false);
    reload();
  }, [workspace, fileSocket, reload]);

  const handlePull = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    await fileSocket.gitPull?.(workspace);
    setLoading(false);
    reload();
  }, [workspace, fileSocket, reload]);

  // Right-click context menu (vscode-style)
  const [ctxMenu, setCtxMenu] = useState(null);
  const copyToClipboard = useCallback(async (text) => {
    try { await navigator.clipboard.writeText(text); } catch {}
  }, []);
  const openCtxMenu = useCallback((file, e) => {
    e.preventDefault();
    e.stopPropagation();
    vibrate();
    setCtxMenu({ file, x: e.clientX, y: e.clientY });
  }, []);
  const buildMenuItems = useCallback((file) => {
    const absPath = joinPath(workspace, file.path);
    return [
      { key: "open", label: "Open File", icon: ExternalLink, disabled: file.status === "D",
        onClick: () => onOpenFile?.(absPath) },
      { key: "copyPath", label: "Copy Path", icon: ExternalLink, onClick: () => copyToClipboard(absPath) },
      { key: "copyRel", label: "Copy Relative Path", icon: ExternalLink, onClick: () => copyToClipboard(file.path) },
      { key: "copyName", label: "Copy Filename", icon: ExternalLink, onClick: () => copyToClipboard(basename(file.path)) },
    ];
  }, [workspace, onOpenFile, copyToClipboard]);

  const renderFileRow = (file, isUntracked) => {
    const colorClass = GIT_STATUS_COLORS[file.status] || "text-text-muted";
    const absPath = joinPath(workspace, file.path);
    return (
      <div
        key={`${file.status}-${file.path}`}
        className="group relative flex items-center gap-1.5 px-2 py-1 hover:bg-surface-2 cursor-pointer"
        onContextMenu={(e) => openCtxMenu(file, e)}
        onClick={() => {
          vibrate();
          // file.path is relative to THIS repo. Where the host shows several repos side by
          // side it must travel with its repo, or the diff is read from the wrong one.
          onOpenFile?.(tagDiffWithRepo
            ? makeRepoDiffPath(file.status, workspace, file.path)
            : makeDiffPath(file.status, file.path));
        }}
      >
        <span className="flex-shrink-0 flex items-center">{resolveFileIcon({ name: basename(file.path), path: file.path, type: "file" }, 16)}</span>
        <span className="truncate text-xs text-text">{basename(file.path)}</span>
        <span className="truncate text-[11px] text-text-muted flex-1">{dirname(file.path)}</span>
        {/* VS Code parity: hover shows only Discard + Stage, floating OVER the directory
            text (no reserved space — the full row width stays readable when not hovered).
            Opening the file itself is a context-menu action; the row click opens the diff. */}
        <div className="absolute right-[22px] top-1/2 -translate-y-1/2 flex items-center gap-0.5 pl-2 pr-1 bg-surface-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            title={isUntracked ? "Delete" : "Discard"}
            onClick={(e) => { e.stopPropagation(); vibrate(); requestDiscard(file); }}
            className="p-0.5 text-text-muted hover:text-text"
          >
            <X size={12} />
          </button>
          <button
            type="button"
            title="Stage"
            onClick={(e) => { e.stopPropagation(); vibrate(); stageFile(file); }}
            className="p-0.5 text-text-muted hover:text-text"
          >
            <Plus size={12} />
          </button>
        </div>
        <span className={`flex-shrink-0 w-4 h-4 flex items-center justify-center text-[10px] font-mono rounded bg-surface-2 ${colorClass}`}>{file.status}</span>
      </div>
    );
  };

  const renderSection = (id, label, list, isUntracked) => {
    const expanded = expandedSections.has(id);
    return (
      <div className="border-t border-border">
        <button
          type="button"
          onClick={() => { vibrate(); toggleSection(id); }}
          className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-2 text-left"
        >
          {expanded ? <ChevronDown size={12} className="text-text-subtle" /> : <ChevronRight size={12} className="text-text-subtle" />}
          <span className="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
          <span className="text-[10px] px-1.5 ml-auto rounded-brand bg-surface-3 text-text-muted">{list.length}</span>
        </button>
        {expanded && list.map((f) => renderFileRow(f, isUntracked))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full text-sm text-text">
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="flex items-center gap-2">
          <GitBranch size={14} className="text-text-muted" />
          <span className="text-xs text-text truncate flex-1">{branch || "—"}</span>
          {ahead > 0 && <span className="text-[10px] font-medium px-1.5 rounded-brand bg-brand-500/15 text-brand-500">↑{ahead}</span>}
          {behind > 0 && <span className="text-[10px] font-medium px-1.5 rounded-brand bg-surface-3 text-text-muted">↓{behind}</span>}
          <button
            type="button"
            title="Refresh"
            onClick={() => { vibrate(); reload(); }}
            className="p-1 text-text-muted hover:text-text"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={2}
          placeholder="Message"
          className="w-full bg-surface-2 border border-border rounded-brand px-2 py-1 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500 resize-none"
        />

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!commitMsg.trim() || !files.length}
            onClick={handleCommitClick}
            className="flex-1 h-7 text-xs rounded-brand bg-brand-500 text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Commit
          </button>
          <button
            type="button"
            onClick={() => { vibrate(); stageAll(); }}
            disabled={!files.length}
            className="px-2 h-7 text-xs rounded-brand bg-surface-2 text-text hover:bg-surface-3 disabled:opacity-40"
            title="Stage all"
          >
            Stage All
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { vibrate(); handlePush(); }}
            className="flex-1 h-6 text-[11px] rounded-brand bg-surface-2 text-text hover:bg-surface-3"
          >
            Push
          </button>
          <button
            type="button"
            onClick={() => { vibrate(); handlePull(); }}
            className="flex-1 h-6 text-[11px] rounded-brand bg-surface-2 text-text hover:bg-surface-3"
          >
            Pull
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {renderSection(SECTION_CHANGES, "Changes", changes, false)}
        {renderSection(SECTION_UNTRACKED, "Untracked", untracked, true)}
      </div>

      <ConfirmDialog
        isOpen={confirmAutoStageOpen}
        onClose={() => setConfirmAutoStageOpen(false)}
        onConfirm={confirmAutoStageAndCommit}
        title="Stage All & Commit"
        message="No changes are staged. Stage all changes and commit?"
        confirmText="Stage & Commit"
        cancelText="Cancel"
      />

      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        onClose={() => { setConfirmDiscardOpen(false); setDiscardTarget(null); }}
        onConfirm={() => { if (discardTarget) discardFile(discardTarget); setDiscardTarget(null); }}
        title="Discard Changes"
        message={discardTarget ? `Discard changes to ${basename(discardTarget.path)}?` : ""}
        confirmText="Discard"
        cancelText="Cancel"
      />

      {ctxMenu && (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(ctxMenu.file)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
