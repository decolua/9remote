"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import "diff2html/bundles/css/diff2html.min.css";
import { GIT_STATUS_COLORS, DIFF_SIDE_BY_SIDE_BREAKPOINT } from "../constants/fileExplorer.js";
import { resolveFileIcon } from "../constants/fileIcons.js";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import GitActionsModal from "./GitActionsModal.js";
import { ChevronLeft, Eye, Trash2, RefreshCw, GitBranch } from "@/shared/components/ui/Icon";
import FileContextMenu, { FILE_MENU_ICONS } from "@/shared/components/ui/FileContextMenu";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Parse unified diff text into flat rows for the mobile (no-table) renderer
function parseUnifiedDiff(text) {
  const rows = [];
  let oldLn = 0, newLn = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("diff --git")) rows.push({ type: "file", text: line.replace("diff --git a/", "").split(" b/")[0] });
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); }
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ type: "add", text: line.slice(1), newLn: newLn++ });
    else if (line.startsWith("-")) rows.push({ type: "del", text: line.slice(1), oldLn: oldLn++ });
    else rows.push({ type: "ctx", text: line.slice(1), oldLn: oldLn++, newLn: newLn++ });
  }
  return rows;
}

export default function GitPanel({ workspace, fileSocket, onBack, onOpenFile }) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("status");
  const [statusLoading, setStatusLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusFiles, setStatusFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedFileStatus, setSelectedFileStatus] = useState(null);
  const [diff, setDiff] = useState("");
  const [diffLoaded, setDiffLoaded] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false });
  const [branch, setBranch] = useState("");
  const [ahead, setAhead] = useState(null);
  const [behind, setBehind] = useState(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  // Load git status
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setError("");

    const result = await fileSocket.gitStatus(workspace);

    if (result.success) {
      setStatusFiles(result.files);
    } else {
      setError(result.error);
    }

    fileSocket.gitBranch(workspace).then((r) => {
      if (!r?.success) return;
      setBranch(r.branch);
      setAhead(r.ahead ?? null);
      setBehind(r.behind ?? null);
    });

    setStatusLoading(false);
  }, [workspace, fileSocket]);

  // Load diff
  const loadDiff = useCallback(async (file = null, status = null) => {
    setDiffLoading(true);
    setError("");
    setSelectedFile(file);
    setSelectedFileStatus(status);

    const result = await fileSocket.gitDiff(workspace, file, status);

    if (result.success) {
      setDiff(result.diff);
      setDiffLoaded(true);
    } else {
      setError(result.error);
    }

    setDiffLoading(false);
  }, [workspace, fileSocket]);

  // Load status on mount
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Handle tab switch to diff - load first file if not loaded yet
  const handleSwitchToDiff = useCallback(() => {
    setActiveTab("diff");
    if (!diffLoaded && statusFiles.length > 0) {
      const firstFile = statusFiles[0];
      loadDiff(firstFile.path, firstFile.status);
    }
  }, [diffLoaded, loadDiff, statusFiles]);

  // Handle discard changes (for diff tab)
  const handleDiscard = useCallback(() => {
    if (!selectedFile || !selectedFileStatus) return;
    handleDiscardFile(selectedFile, selectedFileStatus);
  }, [selectedFile, selectedFileStatus]);

  // Handle discard for specific file
  const handleDiscardFile = useCallback((filePath, status) => {
    const fileName = filePath.split("/").pop();
    const isUntracked = status === "?";

    setConfirmDialog({
      isOpen: true,
      title: t("git.discardConfirmTitle"),
      message: isUntracked ? t("git.discardConfirmDelete", { name: fileName }) : t("git.discardConfirmDiscard", { name: fileName }),
      onConfirm: async () => {
        const result = await fileSocket.gitDiscard(workspace, filePath, status);
        if (result.success) {
          await loadStatus();
          // If in diff tab, update selection
          if (activeTab === "diff") {
            const remaining = statusFiles.filter(f => f.path !== filePath);
            if (remaining.length > 0) {
              loadDiff(remaining[0].path, remaining[0].status);
            } else {
              setActiveTab("status");
              setSelectedFile(null);
              setDiff("");
              setDiffLoaded(false);
            }
          }
        } else {
          setError(result.error);
        }
      }
    });
  }, [fileSocket, workspace, loadStatus, loadDiff, statusFiles, activeTab, t]);

  // Open file in editor
  const handleOpenFile = useCallback((filePath) => {
    // git returns relative paths; join against absolute workspace root
    const fullPath = workspace.endsWith("/")
      ? `${workspace}${filePath}`
      : `${workspace}/${filePath}`;
    onOpenFile?.(fullPath);
  }, [workspace, onOpenFile]);

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState(null); // { file, x, y }
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
    const absPath = workspace.endsWith("/") ? `${workspace}${file.path}` : `${workspace}/${file.path}`;
    return [
      { key: "open", label: t("common.open", { defaultValue: "Open" }), icon: FILE_MENU_ICONS.ExternalLink,
        disabled: file.status === "D", onClick: () => handleOpenFile(file.path) },
      { key: "copyPath", label: t("files.copyPath", { defaultValue: "Copy Path" }), icon: FILE_MENU_ICONS.Copy, onClick: () => copyToClipboard(absPath) },
      { key: "copyRel", label: t("files.copyRelPath", { defaultValue: "Copy Relative Path" }), icon: FILE_MENU_ICONS.FileText, onClick: () => copyToClipboard(file.path) },
      { key: "copyName", label: t("files.copyName", { defaultValue: "Copy Filename" }), icon: FILE_MENU_ICONS.FileText, onClick: () => copyToClipboard(file.path.split("/").pop()) },
      { key: "discard", label: t("git.discardChangesTitle", { defaultValue: "Discard Changes" }), icon: FILE_MENU_ICONS.Undo2, danger: true, onClick: () => handleDiscardFile(file.path, file.status) },
    ];
  }, [workspace, t, handleOpenFile, copyToClipboard, handleDiscardFile]);

  // Track viewport: desktop => diff2html side-by-side (VSCode-like); mobile => custom unified rows
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(min-width: ${DIFF_SIDE_BY_SIDE_BREAKPOINT}px)`);
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Desktop diff2html renderer (side-by-side)
  const diffContainerRef = useCallback((node) => {
    if (!node || activeTab !== "diff" || !diff || diffLoading || !isDesktop) return;
    try {
      const diff2htmlUi = new Diff2HtmlUI(node, diff, {
        drawFileList: false,
        matching: "words",
        outputFormat: "side-by-side",
        renderNothingWhenEmpty: false
      });
      diff2htmlUi.draw();
    } catch {
      node.innerHTML = `<pre class="text-text-muted p-4">${diff || t("git.noChanges")}</pre>`;
    }
  }, [activeTab, diff, diffLoading, isDesktop, t]);

  // Mobile: parse unified diff into flat rows (no table) for readable full-width display
  const diffRows = useMemo(() => (isDesktop || !diff ? [] : parseUnifiedDiff(diff)), [isDesktop, diff]);

  const groupedFiles = {
    modified: statusFiles.filter(f => f.status === "M"),
    added: statusFiles.filter(f => f.status === "A"),
    deleted: statusFiles.filter(f => f.status === "D"),
    untracked: statusFiles.filter(f => f.status === "?")
  };

  // Render file item with actions
  const renderFileItem = (file) => {
    const fileName = file.path.split("/").pop();
    const dirPath = file.path.includes("/") ? file.path.substring(0, file.path.lastIndexOf("/") + 1) : "";
    const showStats = file.added > 0 || file.deleted > 0;

    return (
      <div
        key={file.path}
        className="px-3 py-2 bg-surface rounded hover:bg-surface-2 transition"
        onContextMenu={(e) => openCtxMenu(file, e)}
      >
        <div className="flex items-center gap-2">
          {/* File icon (vscode-style by extension) */}
          <span className="flex-shrink-0 flex items-center">{resolveFileIcon({ name: fileName, path: file.path, type: "file" }, 18)}</span>

          {/* File info - clickable to view diff */}
          <button
            onClick={() => { vibrate(); loadDiff(file.path, file.status); setActiveTab("diff"); }}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-text font-medium truncate">{fileName}</div>
            {dirPath && (
              <div className="text-text-muted text-xs truncate">{dirPath}</div>
            )}
          </button>

          {/* Stats */}
          {showStats && (
            <div className="flex items-center gap-1 text-xs flex-shrink-0">
              {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
              {file.deleted > 0 && <span className="text-red-400">-{file.deleted}</span>}
            </div>
          )}

          {/* Open file button (not for deleted) */}
          {file.status !== "D" && (
            <button
              onClick={(e) => { e.stopPropagation(); vibrate(); handleOpenFile(file.path); }}
              className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-200 flex-shrink-0"
              title={t("git.openFile")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          )}

          {/* Discard button */}
          <button
            onClick={(e) => { e.stopPropagation(); vibrate(); handleDiscardFile(file.path, file.status); }}
            className="p-1.5 text-text-muted hover:text-orange-400 hover:bg-surface-2 rounded-brand transition-all duration-200 flex-shrink-0"
            title={t("git.discardChangesTitle")}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>

          {/* Status letter (vscode-style: trailing colored badge, last) */}
          <span className={`font-mono font-bold w-5 h-5 flex items-center justify-center text-[11px] rounded flex-shrink-0 bg-surface-2 ${GIT_STATUS_COLORS[file.status]}`}>
            {file.status}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={() => { vibrate(); onBack(); }}
          className="p-2 bg-surface-2 hover:bg-surface-2 text-text rounded-brand transition-all duration-200"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-text text-lg font-semibold truncate flex items-center gap-2">
          {t("git.title")}{branch ? <span className="text-text-muted font-normal"> · {branch}</span> : null}
          {ahead > 0 && <span className="text-xs font-medium px-1.5 py-0.5 rounded-brand bg-brand-500/15 text-brand-500">↑{ahead}</span>}
          {behind > 0 && <span className="text-xs font-medium px-1.5 py-0.5 rounded-brand bg-surface-3 text-text-muted">↓{behind}</span>}
        </h1>
        <button
          onClick={() => { vibrate(); setActionsOpen(true); }}
          className="ml-auto p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-200"
          title={t("git.gitActions")}
        >
          <GitBranch className="w-5 h-5" />
        </button>
        <button
          onClick={() => {
            vibrate();
            if (activeTab === "status") {
              loadStatus();
            } else {
              loadDiff(selectedFile, selectedFileStatus);
            }
          }}
          className="p-2 bg-surface-2 hover:bg-surface-2 text-text rounded-brand transition-all duration-200"
          title={t("common.refresh")}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border flex-shrink-0">
        <button
          onClick={() => { vibrate(); setActiveTab("status"); }}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "status"
              ? "text-text border-b-2 border-emerald-500"
              : "text-text-muted hover:text-text"
          }`}
        >
          {t("git.status")}
        </button>
        <button
          onClick={() => { vibrate(); handleSwitchToDiff(); }}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "diff"
              ? "text-text border-b-2 border-emerald-500"
              : "text-text-muted hover:text-text"
          }`}
        >
          {t("git.diffTab")}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden modal-scrollable">
        {activeTab === "status" ? (
          statusLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted">
              {t("common.loading")}
            </div>
          ) :
          <div className="p-4 space-y-4">
            {statusFiles.length === 0 ? (
              <div className="text-center text-text-muted py-8">
                {t("git.noChanges")}
              </div>
            ) : (
              <>
                {groupedFiles.modified.length > 0 && (
                  <div>
                    <h3 className="text-text-muted text-sm mb-2">{t("git.modified")} ({groupedFiles.modified.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.modified.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.added.length > 0 && (
                  <div>
                    <h3 className="text-text-muted text-sm mb-2">{t("git.added")} ({groupedFiles.added.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.added.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.deleted.length > 0 && (
                  <div>
                    <h3 className="text-text-muted text-sm mb-2">{t("git.deleted")} ({groupedFiles.deleted.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.deleted.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.untracked.length > 0 && (
                  <div>
                    <h3 className="text-text-muted text-sm mb-2">{t("git.untrackedTitle")} ({groupedFiles.untracked.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.untracked.map(renderFileItem)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="p-4 min-w-0">
            {/* File selector and discard button */}
            {statusFiles.length > 0 && (
              <div className="flex gap-2 mb-4">
                <select
                  value={selectedFile || ""}
                  onChange={(e) => {
                    vibrate();
                    const file = statusFiles.find(f => f.path === e.target.value);
                    if (file) {
                      loadDiff(file.path, file.status);
                    }
                  }}
                  className="flex-1 min-w-0 px-3 py-2 bg-surface-2 rounded text-text focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all duration-150 ease-out"
                >
                  {statusFiles.map(file => (
                    <option key={file.path} value={file.path}>
                      [{file.status}] {file.path}
                    </option>
                  ))}
                </select>
                {selectedFile && selectedFileStatus !== "D" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); handleOpenFile(selectedFile); }}
                    disabled={diffLoading}
                    className="px-4 py-2 bg-surface-3 hover:bg-surface disabled:cursor-not-allowed text-text text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2"
                    title={t("git.openFile")}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => { vibrate(); handleDiscard(); }}
                  disabled={!selectedFile || diffLoading}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-surface-2 disabled:cursor-not-allowed text-white text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2"
                  title={t("git.discardChangesTitle")}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
              </div>
            )}
            
            {diffLoading ? (
              <div className="flex items-center justify-center h-32 text-text-muted">
                {t("common.loading")}
              </div>
            ) : diff ? (
              isDesktop ? (
                <div
                  ref={diffContainerRef}
                  className="diff-dark-theme bg-surface rounded overflow-hidden text-sm"
                />
              ) : (
                <div className="diff-mobile w-full max-w-full rounded-lg overflow-hidden border border-border bg-surface font-mono text-[12.5px] leading-[1.6]">
                  {diffRows.map((row, i) => {
                    if (row.type === "file") return <div key={i} className="px-3 py-2 bg-surface-2 text-text font-semibold break-all">{row.text}</div>;
                    if (row.type === "hunk") return <div key={i} className="px-3 py-1 bg-surface-2/60 text-text-muted select-none break-all">{row.text}</div>;
                    const gutter = row.type === "add" ? row.newLn : row.type === "del" ? row.oldLn : row.newLn;
                    // Semantic tinted bg via theme tokens; text stays `text-text` for contrast in light+dark
                    const bg = row.type === "add" ? "bg-[rgba(var(--success-rgb),0.14)]" : row.type === "del" ? "bg-[rgba(var(--danger-rgb),0.14)]" : "";
                    const signColor = row.type === "add" ? "text-[var(--success)]" : row.type === "del" ? "text-[var(--danger)]" : "text-text-subtle";
                    const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
                    return (
                      <div key={i} className={`flex ${bg}`}>
                        <span className="shrink-0 w-9 px-1 text-right text-text-subtle bg-black/5 select-none">{gutter}</span>
                        <span className={`shrink-0 w-4 text-center font-bold ${signColor} select-none`}>{sign}</span>
                        <span className="flex-1 min-w-0 pr-2 whitespace-pre-wrap break-words text-text">{row.text || "\u00A0"}</span>
                      </div>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="flex items-center justify-center h-32 text-text-muted">
                {t("git.noChanges")}
              </div>
            )}
            <style jsx global>{`
              /* Desktop diff2html — themed via app tokens (adapts to light/dark) */
              .diff-dark-theme .d2h-wrapper { background: transparent; }
              .diff-dark-theme .d2h-file-wrapper {
                border: 1px solid var(--border);
                border-radius: 8px;
                overflow: hidden;
                margin-bottom: 12px;
              }
              .diff-dark-theme .d2h-file-header {
                background: var(--surface-2);
                color: var(--text);
                border-bottom: 1px solid var(--border);
                padding: 8px 12px;
              }
              .diff-dark-theme .d2h-file-name { color: var(--text); }
              .diff-dark-theme .d2h-diff-table {
                font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
                font-size: 12.5px;
                line-height: 1.55;
              }
              .diff-dark-theme .d2h-code-line,
              .diff-dark-theme .d2h-code-side-line { background: var(--surface); padding: 0 8px; }
              .diff-dark-theme .d2h-code-line-ctn { color: var(--text); }
              .diff-dark-theme .d2h-code-linenumber,
              .diff-dark-theme .d2h-code-side-linenumber {
                background: var(--surface-2);
                color: var(--text-subtle);
                border-right: 1px solid var(--border);
                position: static !important;
              }
              /* Deleted lines */
              .diff-dark-theme .d2h-del { background: rgba(var(--danger-rgb), 0.12) !important; border-color: rgba(var(--danger-rgb), 0.3); }
              .diff-dark-theme .d2h-del .d2h-code-line-ctn { color: var(--text); }
              .diff-dark-theme .d2h-del .d2h-code-linenumber { background: rgba(var(--danger-rgb), 0.16); color: var(--danger); }
              /* Added lines */
              .diff-dark-theme .d2h-ins { background: rgba(var(--success-rgb), 0.12) !important; border-color: rgba(var(--success-rgb), 0.3); }
              .diff-dark-theme .d2h-ins .d2h-code-line-ctn { color: var(--text); }
              .diff-dark-theme .d2h-ins .d2h-code-linenumber { background: rgba(var(--success-rgb), 0.16); color: var(--success); }
              /* Inline word-level highlight */
              .diff-dark-theme del { background: rgba(var(--danger-rgb), 0.32); color: var(--text); text-decoration: none; border-radius: 2px; }
              .diff-dark-theme ins { background: rgba(var(--success-rgb), 0.32); color: var(--text); text-decoration: none; border-radius: 2px; }
              /* Hunk info / context */
              .diff-dark-theme .d2h-info { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
              .diff-dark-theme .d2h-code-side-line { border-left-color: var(--border); }
              .diff-dark-theme .d2h-code-side-emptyplaceholder,
              .diff-dark-theme .d2h-emptyplaceholder { background: var(--surface-2); }
              .diff-dark-theme .d2h-file-side-diff { overflow-x: auto; }
            `}</style>
          </div>
        )}
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ isOpen: false })}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
      />
      {actionsOpen && (
        <GitActionsModal
          workspace={workspace}
          fileSocket={fileSocket}
          branch={branch}
          changedCount={statusFiles.length}
          onDone={loadStatus}
          onClose={() => setActionsOpen(false)}
        />
      )}
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
