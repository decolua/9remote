import { useState, useEffect, useCallback, useMemo } from "preact/hooks";
import ConfirmDialog from "./ConfirmDialog";
import GitActionsModal from "./GitActionsModal";
import Icon from "./Icon";
import { useI18n } from "../i18n";
import { vibrate } from "../lib/vibrate";
import { GIT_STATUS_COLORS } from "../lib/fileExplorer/constants";

// Parse unified diff into flat rows for the no-table renderer (mobile/agent).
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

// Port of web GitPanel (Preact). No diff2html — renders diff as preformatted rows.
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
  const [actionsOpen, setActionsOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setError("");
    const result = await fileSocket.gitStatus(workspace);
    if (result.success) setStatusFiles(result.files);
    else setError(result.error);
    fileSocket.gitBranch(workspace).then((r) => { if (r?.success) setBranch(r.branch); });
    setStatusLoading(false);
  }, [workspace, fileSocket]);

  const loadDiff = useCallback(async (file = null, status = null) => {
    setDiffLoading(true);
    setError("");
    setSelectedFile(file);
    setSelectedFileStatus(status);
    const result = await fileSocket.gitDiff(workspace, file, status);
    if (result.success) { setDiff(result.diff); setDiffLoaded(true); }
    else setError(result.error);
    setDiffLoading(false);
  }, [workspace, fileSocket]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSwitchToDiff = useCallback(() => {
    setActiveTab("diff");
    if (!diffLoaded && statusFiles.length > 0) {
      const firstFile = statusFiles[0];
      loadDiff(firstFile.path, firstFile.status);
    }
  }, [diffLoaded, loadDiff, statusFiles]);

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
          if (activeTab === "diff") {
            const remaining = statusFiles.filter((f) => f.path !== filePath);
            if (remaining.length > 0) loadDiff(remaining[0].path, remaining[0].status);
            else { setActiveTab("status"); setSelectedFile(null); setDiff(""); setDiffLoaded(false); }
          }
        } else setError(result.error);
      },
    });
  }, [fileSocket, workspace, loadStatus, loadDiff, statusFiles, activeTab, t]);

  const handleDiscard = useCallback(() => {
    if (!selectedFile || !selectedFileStatus) return;
    handleDiscardFile(selectedFile, selectedFileStatus);
  }, [selectedFile, selectedFileStatus, handleDiscardFile]);

  const handleOpenFile = useCallback((filePath) => {
    const fullPath = `${workspace}/${filePath}`;
    onOpenFile?.(fullPath);
  }, [workspace, onOpenFile]);

  const diffRows = useMemo(() => (!diff ? [] : parseUnifiedDiff(diff)), [diff]);

  const groupedFiles = {
    modified: statusFiles.filter((f) => f.status === "M"),
    added: statusFiles.filter((f) => f.status === "A"),
    deleted: statusFiles.filter((f) => f.status === "D"),
    untracked: statusFiles.filter((f) => f.status === "?"),
  };

  const renderFileItem = (file) => {
    const fileName = file.path.split("/").pop();
    const dirPath = file.path.includes("/") ? file.path.substring(0, file.path.lastIndexOf("/") + 1) : "";
    const showStats = file.added > 0 || file.deleted > 0;
    return (
      <div key={file.path} className="px-3 py-2 bg-surface rounded hover:bg-surface-2 transition">
        <div className="flex items-center gap-2">
          <span className={`font-mono font-bold w-5 flex-shrink-0 ${GIT_STATUS_COLORS[file.status]}`}>{file.status}</span>
          <button
            onClick={() => { vibrate(); loadDiff(file.path, file.status); setActiveTab("diff"); }}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-text font-medium truncate">{fileName}</div>
            {dirPath && <div className="text-text-muted text-xs truncate">{dirPath}</div>}
          </button>
          {showStats && (
            <div className="flex items-center gap-1 text-xs flex-shrink-0">
              {file.added > 0 && <span className="text-green-400">+{file.added}</span>}
              {file.deleted > 0 && <span className="text-red-400">-{file.deleted}</span>}
            </div>
          )}
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
          <button
            onClick={(e) => { e.stopPropagation(); vibrate(); handleDiscardFile(file.path, file.status); }}
            className="p-1.5 text-text-muted hover:text-orange-400 hover:bg-surface-2 rounded-brand transition-all duration-200 flex-shrink-0"
            title={t("git.discardChangesTitle")}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Header */}
      <div className="bg-surface border-b border-border px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button onClick={() => { vibrate(); onBack(); }} className="p-2 bg-surface-2 hover:bg-surface-2 text-text rounded-brand transition-all duration-200">
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1 className="text-text text-lg font-semibold truncate">
          {t("git.title")}{branch ? <span className="text-text-muted font-normal"> · {branch}</span> : null}
        </h1>
        <button
          onClick={() => { vibrate(); setActionsOpen(true); }}
          className="ml-auto p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-200"
          title={t("git.gitActions")}
        >
          <Icon name="gitBranch" size={20} />
        </button>
        <button
          onClick={() => { vibrate(); if (activeTab === "status") loadStatus(); else loadDiff(selectedFile, selectedFileStatus); }}
          className="p-2 bg-surface-2 hover:bg-surface-2 text-text rounded-brand transition-all duration-200"
          title={t("common.refresh")}
        >
          <Icon name="refreshCw" size={20} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border flex-shrink-0">
        <button
          onClick={() => { vibrate(); setActiveTab("status"); }}
          className={`flex-1 py-3 text-center font-medium transition ${activeTab === "status" ? "text-text border-b-2 border-emerald-500" : "text-text-muted hover:text-text"}`}
        >
          {t("git.status")}
        </button>
        <button
          onClick={() => { vibrate(); handleSwitchToDiff(); }}
          className={`flex-1 py-3 text-center font-medium transition ${activeTab === "diff" ? "text-text border-b-2 border-emerald-500" : "text-text-muted hover:text-text"}`}
        >
          {t("git.diffTab")}
        </button>
      </div>

      {error && <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">{error}</div>}

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {activeTab === "status" ? (
          statusLoading ? (
            <div className="flex items-center justify-center h-32 text-text-muted">{t("common.loading")}</div>
          ) : (
            <div className="p-4 space-y-4">
              {statusFiles.length === 0 ? (
                <div className="text-center text-text-muted py-8">{t("git.noChanges")}</div>
              ) : (
                <>
                  {groupedFiles.modified.length > 0 && (
                    <div>
                      <h3 className="text-text-muted text-sm mb-2">{t("git.modified")} ({groupedFiles.modified.length})</h3>
                      <div className="space-y-1">{groupedFiles.modified.map(renderFileItem)}</div>
                    </div>
                  )}
                  {groupedFiles.added.length > 0 && (
                    <div>
                      <h3 className="text-text-muted text-sm mb-2">{t("git.added")} ({groupedFiles.added.length})</h3>
                      <div className="space-y-1">{groupedFiles.added.map(renderFileItem)}</div>
                    </div>
                  )}
                  {groupedFiles.deleted.length > 0 && (
                    <div>
                      <h3 className="text-text-muted text-sm mb-2">{t("git.deleted")} ({groupedFiles.deleted.length})</h3>
                      <div className="space-y-1">{groupedFiles.deleted.map(renderFileItem)}</div>
                    </div>
                  )}
                  {groupedFiles.untracked.length > 0 && (
                    <div>
                      <h3 className="text-text-muted text-sm mb-2">{t("git.untrackedTitle")} ({groupedFiles.untracked.length})</h3>
                      <div className="space-y-1">{groupedFiles.untracked.map(renderFileItem)}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        ) : (
          <div className="p-4 min-w-0">
            {statusFiles.length > 0 && (
              <div className="flex gap-2 mb-4">
                <select
                  value={selectedFile || ""}
                  onChange={(e) => {
                    vibrate();
                    const file = statusFiles.find((f) => f.path === e.target.value);
                    if (file) loadDiff(file.path, file.status);
                  }}
                  className="flex-1 min-w-0 px-3 py-2 bg-surface-2 rounded text-text focus:outline-none focus:ring-2 focus:ring-emerald-500/40 transition-all duration-150 ease-out"
                >
                  {statusFiles.map((file) => (
                    <option key={file.path} value={file.path}>[{file.status}] {file.path}</option>
                  ))}
                </select>
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
              <div className="flex items-center justify-center h-32 text-text-muted">{t("common.loading")}</div>
            ) : diff ? (
              <div className="w-full max-w-full rounded-lg overflow-hidden border border-border bg-surface font-mono text-[12.5px] leading-[1.6]">
                {diffRows.map((row, i) => {
                  if (row.type === "file") return <div key={i} className="px-3 py-2 bg-surface-2 text-text font-semibold break-all">{row.text}</div>;
                  if (row.type === "hunk") return <div key={i} className="px-3 py-1 bg-surface-2/60 text-text-muted select-none break-all">{row.text}</div>;
                  const gutter = row.type === "add" ? row.newLn : row.type === "del" ? row.oldLn : row.newLn;
                  const bg = row.type === "add" ? "bg-[rgba(var(--success-rgb),0.14)]" : row.type === "del" ? "bg-[rgba(var(--danger-rgb),0.14)]" : "";
                  const signColor = row.type === "add" ? "text-[var(--success)]" : row.type === "del" ? "text-[var(--danger)]" : "text-text-subtle";
                  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
                  return (
                    <div key={i} className={`flex ${bg}`}>
                      <span className="shrink-0 w-9 px-1 text-right text-text-subtle bg-black/5 select-none">{gutter}</span>
                      <span className={`shrink-0 w-4 text-center font-bold ${signColor} select-none`}>{sign}</span>
                      <span className="flex-1 min-w-0 pr-2 whitespace-pre-wrap break-words text-text">{row.text || " "}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-32 text-text-muted">{t("git.noChanges")}</div>
            )}
          </div>
        )}
      </div>

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
    </div>
  );
}
