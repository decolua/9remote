"use client";

import { useState, useEffect, useCallback } from "react";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import "diff2html/bundles/css/diff2html.min.css";
import { GIT_STATUS_COLORS } from "../constants/fileExplorer.js";

export default function GitPanel({ workspace, fileSocket, onBack }) {
  const [activeTab, setActiveTab] = useState("status");
  const [statusLoading, setStatusLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [statusFiles, setStatusFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedFileStatus, setSelectedFileStatus] = useState(null);
  const [diff, setDiff] = useState("");
  const [diffLoaded, setDiffLoaded] = useState(false);

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

  // Handle tab switch to diff - load if not loaded yet
  const handleSwitchToDiff = useCallback(() => {
    setActiveTab("diff");
    if (!diffLoaded) {
      loadDiff(null, null);
    }
  }, [diffLoaded, loadDiff]);

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
      node.innerHTML = `<pre class="text-slate-400 p-4">${diff || "No changes"}</pre>`;
    }
  }, [activeTab, diff, diffLoading]);

  const groupedFiles = {
    modified: statusFiles.filter(f => f.status === "M"),
    added: statusFiles.filter(f => f.status === "A"),
    deleted: statusFiles.filter(f => f.status === "D"),
    untracked: statusFiles.filter(f => f.status === "?")
  };

  return (
    <div className="h-full bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="bg-slate-800 border-b border-slate-700 px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
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
          className="ml-auto p-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition"
          title="Refresh"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 flex-shrink-0">
        <button
          onClick={() => setActiveTab("status")}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "status"
              ? "text-white border-b-2 border-emerald-500"
              : "text-slate-400 hover:text-white"
          }`}
        >
          Status
        </button>
        <button
          onClick={handleSwitchToDiff}
          className={`flex-1 py-3 text-center font-medium transition ${
            activeTab === "diff"
              ? "text-white border-b-2 border-emerald-500"
              : "text-slate-400 hover:text-white"
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
      <div className="flex-1 overflow-auto">
        {activeTab === "status" ? (
          statusLoading ? (
            <div className="flex items-center justify-center h-32 text-slate-400">
              Loading...
            </div>
          ) :
          <div className="p-4 space-y-4">
            {statusFiles.length === 0 ? (
              <div className="text-center text-slate-400 py-8">
                No changes
              </div>
            ) : (
              <>
                {groupedFiles.modified.length > 0 && (
                  <div>
                    <h3 className="text-slate-400 text-sm mb-2">Modified ({groupedFiles.modified.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.modified.map(file => (
                        <button
                          key={file.path}
                          onClick={() => { loadDiff(file.path, "M"); setActiveTab("diff"); }}
                          className="w-full px-3 py-2 bg-slate-800 rounded flex items-center gap-2 hover:bg-slate-700 transition text-left"
                        >
                          <span className={`font-mono font-bold ${GIT_STATUS_COLORS.M}`}>M</span>
                          <span className="text-white truncate">{file.path}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {groupedFiles.added.length > 0 && (
                  <div>
                    <h3 className="text-slate-400 text-sm mb-2">Added ({groupedFiles.added.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.added.map(file => (
                        <div key={file.path} className="px-3 py-2 bg-slate-800 rounded flex items-center gap-2">
                          <span className={`font-mono font-bold ${GIT_STATUS_COLORS.A}`}>A</span>
                          <span className="text-white truncate">{file.path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {groupedFiles.deleted.length > 0 && (
                  <div>
                    <h3 className="text-slate-400 text-sm mb-2">Deleted ({groupedFiles.deleted.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.deleted.map(file => (
                        <div key={file.path} className="px-3 py-2 bg-slate-800 rounded flex items-center gap-2">
                          <span className={`font-mono font-bold ${GIT_STATUS_COLORS.D}`}>D</span>
                          <span className="text-white truncate">{file.path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {groupedFiles.untracked.length > 0 && (
                  <div>
                    <h3 className="text-slate-400 text-sm mb-2">Untracked ({groupedFiles.untracked.length})</h3>
                    <div className="space-y-1">
                      {groupedFiles.untracked.map(file => (
                        <button
                          key={file.path}
                          onClick={() => { loadDiff(file.path, "?"); setActiveTab("diff"); }}
                          className="w-full px-3 py-2 bg-slate-800 rounded flex items-center gap-2 hover:bg-slate-700 transition text-left"
                        >
                          <span className={`font-mono font-bold ${GIT_STATUS_COLORS["?"]}`}>?</span>
                          <span className="text-white truncate">{file.path}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="p-4">
            {/* File selector for diff */}
            {statusFiles.length > 0 && (
              <select
                value={selectedFile || ""}
                onChange={(e) => {
                  const file = statusFiles.find(f => f.path === e.target.value);
                  loadDiff(e.target.value || null, file?.status);
                }}
                className="w-full mb-4 px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="">All changes</option>
                {statusFiles.map(file => (
                  <option key={file.path} value={file.path}>
                    [{file.status}] {file.path}
                  </option>
                ))}
              </select>
            )}
            
            {diffLoading ? (
              <div className="flex items-center justify-center h-32 text-slate-400">
                Loading...
              </div>
            ) : diff ? (
              <div 
                ref={diffContainerRef}
                className="diff-dark-theme bg-slate-800 rounded overflow-hidden text-sm"
              />
            ) : (
              <div className="flex items-center justify-center h-32 text-slate-400">
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
    </div>
  );
}
