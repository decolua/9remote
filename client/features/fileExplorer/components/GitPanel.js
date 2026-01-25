"use client";

import { useState, useEffect, useCallback } from "react";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import "diff2html/bundles/css/diff2html.min.css";
import { GIT_STATUS_COLORS } from "../constants/fileExplorer.js";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { ChevronLeft, Eye, Trash2, RefreshCw } from "@/shared/components/ui/Icon";

export default function GitPanel({ workspace, fileSocket, onBack, onOpenFile }) {
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
    const actionText = status === "?" ? "delete" : "discard changes in";
    
    setConfirmDialog({
      isOpen: true,
      title: "Discard Changes",
      message: `Are you sure you want to ${actionText} "${fileName}"? This cannot be undone.`,
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
  }, [fileSocket, workspace, loadStatus, loadDiff, statusFiles, activeTab]);

  // Open file in editor
  const handleOpenFile = useCallback((filePath) => {
    const fullPath = `${workspace}/${filePath}`;
    onOpenFile?.(fullPath);
  }, [workspace, onOpenFile]);

  // Render diff with diff2html - use ref for stable reference
  const diffContainerRef = useCallback((node) => {
    if (!node || activeTab !== "diff" || !diff || diffLoading) return;

    try {
      const diff2htmlUi = new Diff2HtmlUI(node, diff, {
        drawFileList: false,
        matching: "lines",
        outputFormat: "line-by-line",
        renderNothingWhenEmpty: false
      });
      diff2htmlUi.draw();
    } catch {
      node.innerHTML = `<pre class="text-dark-100 p-4">${diff || "No changes"}</pre>`;
    }
  }, [activeTab, diff, diffLoading]);

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
        className="px-3 py-2 bg-dark-600 rounded hover:bg-dark-500 transition"
      >
        <div className="flex items-center gap-2">
          {/* Status badge */}
          <span className={`font-mono font-bold w-5 flex-shrink-0 ${GIT_STATUS_COLORS[file.status]}`}>
            {file.status}
          </span>
          
          {/* File info - clickable to view diff */}
          <button
            onClick={() => { loadDiff(file.path, file.status); setActiveTab("diff"); }}
            className="flex-1 min-w-0 text-left"
          >
            <div className="text-white font-medium truncate">{fileName}</div>
            {dirPath && (
              <div className="text-dark-100 text-xs truncate">{dirPath}</div>
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
              onClick={(e) => { e.stopPropagation(); handleOpenFile(file.path); }}
              className="p-1.5 text-dark-100 hover:text-white hover:bg-dark-400 rounded-brand transition-all duration-200 flex-shrink-0"
              title="Open file"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          )}
          
          {/* Discard button */}
          <button
            onClick={(e) => { e.stopPropagation(); handleDiscardFile(file.path, file.status); }}
            className="p-1.5 text-dark-100 hover:text-orange-400 hover:bg-dark-400 rounded-brand transition-all duration-200 flex-shrink-0"
            title="Discard changes"
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
    <div className="h-full bg-dark-700 flex flex-col">
      {/* Header */}
      <div className="bg-dark-600 border-b border-dark-400 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-white text-lg font-semibold">Git</h1>
        <button
          onClick={() => {
            if (activeTab === "status") {
              loadStatus();
            } else {
              loadDiff(selectedFile, selectedFileStatus);
            }
          }}
          className="ml-auto p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200"
          title="Refresh"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-dark-400 flex-shrink-0">
        <button
          onClick={() => setActiveTab("status")}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "status"
              ? "text-white border-b-2 border-emerald-500"
              : "text-dark-100 hover:text-white"
          }`}
        >
          Status
        </button>
        <button
          onClick={handleSwitchToDiff}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "diff"
              ? "text-white border-b-2 border-emerald-500"
              : "text-dark-100 hover:text-white"
          }`}
        >
          Diff
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto modal-scrollable">
        {activeTab === "status" ? (
          statusLoading ? (
            <div className="flex items-center justify-center h-32 text-dark-100">
              Loading...
            </div>
          ) :
          <div className="p-4 space-y-4">
            {statusFiles.length === 0 ? (
              <div className="text-center text-dark-100 py-8">
                No changes
              </div>
            ) : (
              <>
                {groupedFiles.modified.length > 0 && (
                  <div>
                    <h3 className="text-dark-100 text-sm mb-2">Modified ({groupedFiles.modified.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.modified.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.added.length > 0 && (
                  <div>
                    <h3 className="text-dark-100 text-sm mb-2">Added ({groupedFiles.added.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.added.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.deleted.length > 0 && (
                  <div>
                    <h3 className="text-dark-100 text-sm mb-2">Deleted ({groupedFiles.deleted.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.deleted.map(renderFileItem)}
                    </div>
                  </div>
                )}

                {groupedFiles.untracked.length > 0 && (
                  <div>
                    <h3 className="text-dark-100 text-sm mb-2">Untracked ({groupedFiles.untracked.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.untracked.map(renderFileItem)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="p-4">
            {/* File selector and discard button */}
            {statusFiles.length > 0 && (
              <div className="flex gap-2 mb-4">
                <select
                  value={selectedFile || ""}
                  onChange={(e) => {
                    const file = statusFiles.find(f => f.path === e.target.value);
                    if (file) {
                      loadDiff(file.path, file.status);
                    }
                  }}
                  className="flex-1 px-3 py-2 bg-dark-600 border border-dark-400 rounded text-white focus:outline-none focus:border-emerald-500"
                >
                  {statusFiles.map(file => (
                    <option key={file.path} value={file.path}>
                      [{file.status}] {file.path}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleDiscard}
                  disabled={!selectedFile || diffLoading}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-dark-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2"
                  title="Discard changes"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
              </div>
            )}
            
            {diffLoading ? (
              <div className="flex items-center justify-center h-32 text-dark-100">
                Loading...
              </div>
            ) : diff ? (
              <div 
                ref={diffContainerRef}
                className="diff-dark-theme bg-dark-600 rounded overflow-hidden text-sm"
              />
            ) : (
              <div className="flex items-center justify-center h-32 text-dark-100">
                No changes
              </div>
            )}
            <style jsx global>{`
              .diff-dark-theme .d2h-wrapper {
                background: transparent;
              }
              .diff-dark-theme .d2h-file-header {
                background: #334155;
                color: #f1f5f9;
                border-bottom: 1px solid #475569;
              }
              .diff-dark-theme .d2h-file-name {
                color: #f1f5f9;
              }
              .diff-dark-theme .d2h-code-line {
                background: #1e293b;
              }
              .diff-dark-theme .d2h-code-line-ctn {
                color: #e2e8f0;
              }
              .diff-dark-theme .d2h-code-linenumber {
                background: #334155;
                color: #94a3b8;
                border-right: 1px solid #475569;
                position: static !important;
              }
              /* Deleted lines - red */
              .diff-dark-theme .d2h-del {
                background: rgba(239, 68, 68, 0.2) !important;
                border-color: rgba(239, 68, 68, 0.4);
              }
              .diff-dark-theme .d2h-del .d2h-code-line-ctn {
                color: #fca5a5;
              }
              .diff-dark-theme .d2h-del .d2h-code-linenumber {
                background: rgba(239, 68, 68, 0.3);
                color: #fca5a5;
              }
              /* Added lines - green */
              .diff-dark-theme .d2h-ins {
                background: rgba(34, 197, 94, 0.2) !important;
                border-color: rgba(34, 197, 94, 0.4);
              }
              .diff-dark-theme .d2h-ins .d2h-code-line-ctn {
                color: #86efac;
              }
              .diff-dark-theme .d2h-ins .d2h-code-linenumber {
                background: rgba(34, 197, 94, 0.3);
                color: #86efac;
              }
              /* Inline changes highlight */
              .diff-dark-theme del {
                background: rgba(239, 68, 68, 0.4);
                color: #fecaca;
                text-decoration: none;
              }
              .diff-dark-theme ins {
                background: rgba(34, 197, 94, 0.4);
                color: #bbf7d0;
                text-decoration: none;
              }
              /* Info and context */
              .diff-dark-theme .d2h-info {
                background: #334155;
                color: #94a3b8;
                border-color: #475569;
              }
              .diff-dark-theme .d2h-code-side-line {
                border-left-color: #475569;
              }
              /* Empty placeholder */
              .diff-dark-theme .d2h-code-side-emptyplaceholder {
                background: #1e293b;
              }
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
    </div>
  );
}
