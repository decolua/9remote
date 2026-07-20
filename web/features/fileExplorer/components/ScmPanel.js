"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus, RefreshCw, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { GIT_STATUS_COLORS, makeDiffPath } from "../constants/fileExplorer.js";

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

export default function ScmPanel({ workspace, fileSocket, onOpenFile }) {
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

  const renderFileRow = (file, isUntracked) => {
    const colorClass = GIT_STATUS_COLORS[file.status] || "text-text-muted";
    return (
      <div
        key={`${file.status}-${file.path}`}
        className="group flex items-center gap-1 px-2 py-1 hover:bg-surface-2 cursor-pointer"
        onClick={() => { vibrate(); onOpenFile?.(makeDiffPath(file.status, file.path)); }}
      >
        <span className={`w-3 text-center text-[11px] font-mono ${colorClass}`}>{file.status}</span>
        <span className="truncate text-xs text-text">{basename(file.path)}</span>
        <span className="truncate text-[11px] text-text-muted flex-1">{dirname(file.path)}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
    </div>
  );
}
