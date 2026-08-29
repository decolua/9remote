"use client";

import { memo, useState, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus, RefreshCw, X, ExternalLink, MoreHorizontal, ArrowUp, ArrowDown } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import FileContextMenu from "@/shared/components/ui/FileContextMenu";
import { useI18n } from "@/shared/i18n";
import { GIT_STATUS_COLORS, GIT_REFRESH_EVENT, makeDiffPath, makeRepoDiffPath } from "../constants/fileExplorer.js";
import { resolveFileIcon } from "../constants/fileIcons.js";
import { commitSummary, pushSummary, pullSummary } from "../lib/gitOutput.js";

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

// One changed-file row. Memoized so typing a commit message (panel-level state) does not
// re-render the whole file list per keystroke — handlers take the row's `file`, so every
// row shares one stable identity.
const ScmFileRow = memo(function ScmFileRow({ file, workspace, isUntracked, t, openDiff, onCtxMenu, onDiscard, onStage }) {
  const colorClass = GIT_STATUS_COLORS[file.status] || "text-text-muted";
  const absPath = joinPath(workspace, file.path);
  return (
    <div
      className="group relative flex items-center gap-1.5 px-2 py-1 hover:bg-surface-2 cursor-pointer"
      onContextMenu={(e) => onCtxMenu(file, e)}
      onClick={() => {
        vibrate();
        // file.path is relative to THIS repo. Where the host shows several repos side by
        // side it must travel with its repo, or the diff is read from the wrong one.
        openDiff(file);
      }}
    >
      <span className="flex-shrink-0 flex items-center">{resolveFileIcon({ name: basename(file.path), path: file.path, type: "file" }, 16)}</span>
      <span className="truncate text-xs text-text" title={file.path}>{basename(file.path)}</span>
      <span className="truncate text-[11px] text-text-muted flex-1" title={dirname(file.path)}>{dirname(file.path)}</span>
      {/* VS Code parity: hover shows only Discard + Stage, floating OVER the directory
          text (no reserved space — the full row width stays readable when not hovered).
          Opening the file itself is a context-menu action; the row click opens the diff. */}
      <div className="absolute right-[22px] top-1/2 -translate-y-1/2 flex items-center gap-0.5 pl-2 pr-1 bg-surface-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          title={isUntracked ? t("common.delete") : t("git.discard")}
          onClick={(e) => { e.stopPropagation(); vibrate(); onDiscard(file); }}
          className="p-0.5 text-text-muted hover:text-text"
        >
          <X size={12} />
        </button>
        <button
          type="button"
          title={t("git.stage")}
          onClick={(e) => { e.stopPropagation(); vibrate(); onStage(file); }}
          className="p-0.5 text-text-muted hover:text-text"
        >
          <Plus size={12} />
        </button>
      </div>
      <span className={`flex-shrink-0 w-4 h-4 flex items-center justify-center text-[10px] font-mono rounded bg-surface-2 ${colorClass}`}>{file.status}</span>
    </div>
  );
});

export default function ScmPanel({ workspace, fileBus, onOpenFile, tagDiffWithRepo = false }) {
  const { t } = useI18n();
  const [branch, setBranch] = useState("");
  const [ahead, setAhead] = useState(null);
  const [behind, setBehind] = useState(null);
  const [files, setFiles] = useState([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  const [expandedSections, setExpandedSections] = useState(new Set([SECTION_CHANGES, SECTION_UNTRACKED]));
  const [confirmAutoStageOpen, setConfirmAutoStageOpen] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState(null);
  // Split-button menu (VS Code parity): the primary action commits, the arrow
  // offers the variants. `pendingPush` defers the push until the stage confirm returns.
  const [pendingPush, setPendingPush] = useState(false);
  const [commitMenu, setCommitMenu] = useState(null);
  const [moreMenu, setMoreMenu] = useState(null);

  const reload = useCallback(async () => {
    if (!workspace || !fileBus) return;
    setLoading(true);
    const [statusRes, branchRes] = await Promise.all([
      fileBus.gitStatus?.(workspace),
      fileBus.gitBranch?.(workspace)
    ]);
    setLoading(false);
    if (statusRes?.success) setFiles(statusRes.files || []);
    if (branchRes?.success) {
      setBranch(branchRes.branch || "");
      setAhead(branchRes.ahead ?? null);
      setBehind(branchRes.behind ?? null);
    }
  }, [workspace, fileBus]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-refresh when files saved/created/deleted/renamed elsewhere
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => reload();
    const events = ["fileExplorer:fileSaved", "fileExplorer:fileCreated", "fileExplorer:fileDeleted", "fileExplorer:fileRenamed", GIT_REFRESH_EVENT];
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
    await fileBus.gitAdd?.(workspace, [file.path]);
    reload();
  }, [workspace, fileBus, reload]);

  const stageAll = useCallback(async () => {
    if (!workspace) return;
    await fileBus.gitAdd?.(workspace, ["."]);
    reload();
  }, [workspace, fileBus, reload]);

  const discardFile = useCallback(async (file) => {
    if (!workspace) return;
    await fileBus.gitDiscard?.(workspace, file.path, file.status);
    reload();
  }, [workspace, fileBus, reload]);

  const requestDiscard = useCallback((file) => {
    setDiscardTarget(file);
    setConfirmDiscardOpen(true);
  }, []);

  const openDiff = useCallback((file) => {
    onOpenFile?.(tagDiffWithRepo
      ? makeRepoDiffPath(file.status, workspace, file.path)
      : makeDiffPath(file.status, file.path));
  }, [onOpenFile, tagDiffWithRepo, workspace]);

  const handleCommitClick = useCallback((withPush = false) => {
    if (!commitMsg.trim()) return;
    if (!files.length) return;
    setPendingPush(withPush);
    setConfirmAutoStageOpen(true);
  }, [commitMsg, files]);

  const confirmAutoStageAndCommit = useCallback(async () => {
    if (!workspace) return;
    setResult(null);
    const add = await fileBus.gitAdd?.(workspace, ["."]);
    if (add && !add.success) {
      setResult({ ok: false, text: add.error || t("git.stageFailed") });
      return;
    }
    const res = await fileBus.gitCommit?.(workspace, commitMsg.trim());
    if (!res?.success) {
      setResult({ ok: false, text: res?.output || res?.error || t("git.commitFailed") });
      reload();
      return;
    }
    setCommitMsg("");
    if (!pendingPush) {
      setResult({ ok: true, text: commitSummary(t, res.output) });
      reload();
      return;
    }
    const pushed = await fileBus.gitPush?.(workspace);
    setResult(pushed?.success
      ? { ok: true, text: `${commitSummary(t, res.output)} · ${pushSummary(t, pushed.output)}` }
      : { ok: false, text: pushed?.output || pushed?.error || t("git.pushFailed") });
    reload();
  }, [workspace, fileBus, commitMsg, pendingPush, reload, t]);

  const handlePush = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setResult(null);
    const res = await fileBus.gitPush?.(workspace);
    setLoading(false);
    setResult(res?.success
      ? { ok: true, text: pushSummary(t, res.output) }
      : { ok: false, text: res?.output || res?.error || t("git.pushFailed") });
    reload();
  }, [workspace, fileBus, reload, t]);

  const handlePull = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setResult(null);
    const res = await fileBus.gitPull?.(workspace);
    setLoading(false);
    setResult(res?.success
      ? { ok: true, text: pullSummary(t, res.output) }
      : { ok: false, text: res?.output || res?.error || t("git.pullFailed") });
    reload();
  }, [workspace, fileBus, reload, t]);


  const anchorMenu = useCallback((e, set) => {
    e.stopPropagation();
    vibrate();
    const r = e.currentTarget.getBoundingClientRect();
    set({ x: r.right, y: r.bottom + 4 });
  }, []);

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
      { key: "open", label: t("git.openFile"), icon: ExternalLink, disabled: file.status === "D",
        onClick: () => onOpenFile?.(absPath) },
      { key: "copyPath", label: t("files.copyPath", { defaultValue: "Copy Path" }), icon: ExternalLink, onClick: () => copyToClipboard(absPath) },
      { key: "copyRel", label: t("files.copyRelPath", { defaultValue: "Copy Relative Path" }), icon: ExternalLink, onClick: () => copyToClipboard(file.path) },
      { key: "copyName", label: t("files.copyName", { defaultValue: "Copy Filename" }), icon: ExternalLink, onClick: () => copyToClipboard(basename(file.path)) },
    ];
  }, [workspace, onOpenFile, copyToClipboard, t]);

  const renderFileRow = (file, isUntracked) => (
    <ScmFileRow
      key={`${file.status}-${file.path}`}
      file={file}
      workspace={workspace}
      isUntracked={isUntracked}
      t={t}
      openDiff={openDiff}
      onCtxMenu={openCtxMenu}
      onDiscard={requestDiscard}
      onStage={stageFile}
    />
  );

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
            title={t("common.refresh")}
            onClick={() => { vibrate(); reload(); }}
            className="p-1 text-text-muted hover:text-text"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            title={t("git.gitActions")}
            onClick={(e) => anchorMenu(e, setMoreMenu)}
            className="p-1 text-text-muted hover:text-text"
          >
            <MoreHorizontal size={12} />
          </button>
        </div>

        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={2}
          placeholder={t("git.commitPlaceholder")}
          className="w-full bg-surface-2 border border-border rounded-brand px-2 py-1 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500 resize-none"
        />

        {/* VS Code parity: one primary Commit split-button; every other git action
            lives behind the arrow or the "…" in the branch row. */}
        <div className={`flex items-stretch h-7 rounded-brand overflow-hidden bg-brand-500 text-white transition-opacity ${
          !commitMsg.trim() || !files.length ? "opacity-40" : ""
        }`}>
          <button
            type="button"
            disabled={!commitMsg.trim() || !files.length}
            onClick={() => { vibrate(); handleCommitClick(false); }}
            className="flex-1 text-xs hover:bg-black/10 disabled:cursor-not-allowed transition-colors"
          >
            {t("git.commit")}
          </button>
          <span className="w-px my-1.5 bg-white/25" />
          <button
            type="button"
            title={t("git.gitActions")}
            disabled={!commitMsg.trim() || !files.length}
            onClick={(e) => anchorMenu(e, setCommitMenu)}
            className="px-1.5 flex items-center hover:bg-black/10 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronDown size={12} />
          </button>
        </div>

        {result && (
          <div className={`text-[11px] leading-snug break-words rounded-brand px-2 py-1 ${
            result.ok
              ? "text-[var(--success)] bg-[rgba(var(--success-rgb),0.1)]"
              : "text-[var(--danger)] bg-[rgba(var(--danger-rgb),0.1)]"
          }`}>
            {result.text}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {renderSection(SECTION_CHANGES, t("git.changes"), changes, false)}
        {renderSection(SECTION_UNTRACKED, t("git.untracked"), untracked, true)}
      </div>

      <ConfirmDialog
        isOpen={confirmAutoStageOpen}
        onClose={() => setConfirmAutoStageOpen(false)}
        onConfirm={confirmAutoStageAndCommit}
        title={t("git.stageAllConfirmTitle")}
        message={t("git.stageAllConfirmMessage")}
        confirmText={t("git.stageAndCommit")}
        cancelText={t("common.cancel")}
      />

      <ConfirmDialog
        isOpen={confirmDiscardOpen}
        onClose={() => { setConfirmDiscardOpen(false); setDiscardTarget(null); }}
        onConfirm={() => { if (discardTarget) discardFile(discardTarget); setDiscardTarget(null); }}
        title={t("git.discardConfirmTitle")}
        message={discardTarget
          ? (discardTarget.status === "?"
            ? t("git.discardConfirmDelete", { name: basename(discardTarget.path) })
            : t("git.discardConfirmDiscard", { name: basename(discardTarget.path) }))
          : ""}
        confirmText={t("git.discard")}
        cancelText={t("common.cancel")}
      />

      {ctxMenu && (
        <FileContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(ctxMenu.file)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {commitMenu && (
        <FileContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          items={[
            { key: "commitPush", label: t("git.commitAndPush"), icon: ArrowUp,
              disabled: !commitMsg.trim() || !files.length,
              onClick: () => handleCommitClick(true) }
          ]}
          onClose={() => setCommitMenu(null)}
        />
      )}

      {moreMenu && (
        <FileContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={[
            { key: "push", label: t("git.push"), icon: ArrowUp, onClick: handlePush },
            { key: "pull", label: t("git.pull"), icon: ArrowDown, onClick: handlePull },
            { key: "stageAll", label: t("git.stageAll"), icon: Plus, disabled: !files.length, onClick: stageAll }
          ]}
          onClose={() => setMoreMenu(null)}
        />
      )}
    </div>
  );
}
