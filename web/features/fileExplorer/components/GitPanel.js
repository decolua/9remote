"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { GIT_STATUS_COLORS, GIT_REFRESH_EVENT, isImageFile } from "../constants/fileExplorer.js";
import { resolveFileIcon } from "../constants/fileIcons.js";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import GitActionsModal from "./GitActionsModal.js";
import { ChevronLeft, Eye, Trash2, RefreshCw, GitBranch } from "@/shared/components/ui/Icon";
import FileContextMenu, { FILE_MENU_ICONS } from "@/shared/components/ui/FileContextMenu";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import DiffBody from "./DiffBody.js";
import ImageDiffView from "./ImageDiffView.js";
import { addToGitignore } from "../lib/gitignore.js";

export default function GitPanel({ workspace, fileBus, onBack, onOpenFile }) {
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

    const result = await fileBus.gitStatus(workspace);

    if (result.success) {
      setStatusFiles(result.files);
    } else {
      setError(result.error);
    }

    fileBus.gitBranch(workspace).then((r) => {
      if (!r?.success) return;
      setBranch(r.branch);
      setAhead(r.ahead ?? null);
      setBehind(r.behind ?? null);
    });

    setStatusLoading(false);
  }, [workspace, fileBus]);

  // Load diff
  const loadDiff = useCallback(async (file = null, status = null) => {
    setSelectedFile(file);
    setSelectedFileStatus(status);
    if (file && isImageFile(file)) {
      setDiff("image");
      setDiffLoaded(true);
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    setError("");

    const result = await fileBus.gitDiff(workspace, file, status);

    if (result.success) {
      setDiff(result.diff);
      setDiffLoaded(true);
    } else {
      setError(result.error);
    }

    setDiffLoading(false);
  }, [workspace, fileBus]);

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
        const result = await fileBus.gitDiscard(workspace, filePath, status);
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
  }, [fileBus, workspace, loadStatus, loadDiff, statusFiles, activeTab, t]);

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
  const handleAddToGitignore = useCallback(async (file) => {
    if (!workspace || !fileBus || !file?.path) return;
    const res = await addToGitignore(fileBus, workspace, file.path);
    if (res?.success) {
      window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT));
      loadStatus();
    }
  }, [workspace, fileBus, loadStatus]);

  const buildMenuItems = useCallback((file) => {
    const absPath = workspace.endsWith("/") ? `${workspace}${file.path}` : `${workspace}/${file.path}`;
    return [
      { key: "open", label: t("common.open", { defaultValue: "Open" }), icon: FILE_MENU_ICONS.ExternalLink,
        disabled: file.status === "D", onClick: () => handleOpenFile(file.path) },
      { key: "copyPath", label: t("files.copyPath", { defaultValue: "Copy Path" }), icon: FILE_MENU_ICONS.Copy, onClick: () => copyToClipboard(absPath) },
      { key: "copyRel", label: t("files.copyRelPath", { defaultValue: "Copy Relative Path" }), icon: FILE_MENU_ICONS.FileText, onClick: () => copyToClipboard(file.path) },
      { key: "copyName", label: t("files.copyName", { defaultValue: "Copy Filename" }), icon: FILE_MENU_ICONS.FileText, onClick: () => copyToClipboard(file.path.split("/").pop()) },
      { key: "addToGitignore", label: t("git.addToGitignore", { defaultValue: "Add to .gitignore" }), icon: FILE_MENU_ICONS.EyeOff, onClick: () => handleAddToGitignore(file) },
      { key: "discard", label: t("git.discardChangesTitle", { defaultValue: "Discard Changes" }), icon: FILE_MENU_ICONS.Undo2, danger: true, onClick: () => handleDiscardFile(file.path, file.status) },
    ];
  }, [workspace, t, handleOpenFile, copyToClipboard, handleAddToGitignore, handleDiscardFile]);

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
            <div className="text-text font-medium truncate" title={file.path}>{fileName}</div>
            {dirPath && (
              <div className="text-text-muted text-xs truncate" title={dirPath}>{dirPath}</div>
            )}
          </button>

          {/* Stats */}
          {showStats && (
            <div className="flex items-center gap-1 text-xs flex-shrink-0">
              {file.added > 0 && <span className="text-[var(--success)]">+{file.added}</span>}
              {file.deleted > 0 && <span className="text-[var(--danger)]">-{file.deleted}</span>}
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
            className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-all duration-200 flex-shrink-0"
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
              ? "text-text border-b-2 border-brand-500"
              : "text-text-muted hover:text-text"
          }`}
        >
          {t("git.status")}
        </button>
        <button
          onClick={() => { vibrate(); handleSwitchToDiff(); }}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "diff"
              ? "text-text border-b-2 border-brand-500"
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
                  className="flex-1 min-w-0 px-3 py-2 bg-surface-2 rounded-brand text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out"
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
                    className="h-9 w-9 flex-shrink-0 bg-surface-2 hover:bg-surface-3 disabled:cursor-not-allowed text-text rounded-brand transition-all duration-200 flex items-center justify-center"
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
                  className="h-9 w-9 flex-shrink-0 bg-red-500/10 hover:bg-red-500/20 disabled:bg-surface-2 disabled:cursor-not-allowed text-red-400 rounded-brand transition-all duration-200 flex items-center justify-center"
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
            ) : selectedFile && isImageFile(selectedFile) ? (
              <ImageDiffView
                filePath={selectedFile}
                status={selectedFileStatus}
                workspace={workspace}
                fileBus={fileBus}
              />
            ) : diff ? (
              <DiffBody diff={diff} />
            ) : (
              <div className="flex items-center justify-center h-32 text-text-muted">
                {t("git.noChanges")}
              </div>
            )}
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
          fileBus={fileBus}
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
