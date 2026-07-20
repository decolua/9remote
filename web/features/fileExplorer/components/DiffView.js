"use client";

import { useState, useEffect, useCallback } from "react";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import "diff2html/bundles/css/diff2html.min.css";
import { ExternalLink } from "@/shared/components/ui/Icon";
import { parseDiffPath } from "../constants/fileExplorer.js";

// Read-only git diff viewer (side-by-side), rendered as a virtual editor tab
export default function DiffView({ diffPath, workspace, fileSocket, onOpenFile }) {
  const { status, absPath } = parseDiffPath(diffPath);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fileSocket.gitDiff?.(workspace, absPath, status).then((r) => {
      if (cancelled) return;
      if (r?.success) setDiff(r.diff || "");
      else setError(r?.error || "");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspace, absPath, status, fileSocket]);

  const handleOpen = () => {
    if (!onOpenFile || !absPath) return;
    onOpenFile(absPath);
  };

  const containerRef = useCallback((node) => {
    if (!node || loading || !diff) return;
    try {
      new Diff2HtmlUI(node, diff, {
        drawFileList: false,
        matching: "words",
        outputFormat: "side-by-side",
        renderNothingWhenEmpty: false
      }).draw();
    } catch {
      node.innerHTML = `<pre class="text-text-muted p-4">${diff}</pre>`;
    }
  }, [loading, diff]);

  return (
    <div className="h-full overflow-auto p-3">
      <div className="flex items-center justify-end mb-2">
        {onOpenFile && absPath && (
          <button
            type="button"
            onClick={handleOpen}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
            title="Open file"
          >
            <ExternalLink size={12} />
            <span>Open file</span>
          </button>
        )}
      </div>
      {error && (
        <div className="bg-red-500/20 border-b border-red-500/50 px-4 py-2 text-red-400 text-sm mb-3">{error}</div>
      )}
      {loading ? (
        <div className="flex items-center justify-center h-32 text-text-muted text-sm">Loading...</div>
      ) : diff ? (
        <div ref={containerRef} className="diff-dark-theme bg-surface rounded overflow-hidden text-sm" />
      ) : (
        <div className="flex items-center justify-center h-32 text-text-muted text-sm">No changes</div>
      )}
      <style jsx global>{`
        .diff-dark-theme .d2h-wrapper { background: transparent; }
        .diff-dark-theme .d2h-file-wrapper { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
        .diff-dark-theme .d2h-file-header { background: var(--surface-2); color: var(--text); border-bottom: 1px solid var(--border); padding: 8px 12px; }
        .diff-dark-theme .d2h-file-name { color: var(--text); }
        .diff-dark-theme .d2h-diff-table { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; font-size: 12.5px; line-height: 1.55; }
        .diff-dark-theme .d2h-code-line, .diff-dark-theme .d2h-code-side-line { background: var(--surface); padding: 0 8px; }
        .diff-dark-theme .d2h-code-line-ctn { color: var(--text); }
        .diff-dark-theme .d2h-code-linenumber, .diff-dark-theme .d2h-code-side-linenumber { background: var(--surface-2); color: var(--text-subtle); border-right: 1px solid var(--border); position: static !important; }
        .diff-dark-theme .d2h-del { background: rgba(var(--danger-rgb), 0.12) !important; border-color: rgba(var(--danger-rgb), 0.3); }
        .diff-dark-theme .d2h-del .d2h-code-line-ctn { color: var(--text); }
        .diff-dark-theme .d2h-del .d2h-code-linenumber { background: rgba(var(--danger-rgb), 0.16); color: var(--danger); }
        .diff-dark-theme .d2h-ins { background: rgba(var(--success-rgb), 0.12) !important; border-color: rgba(var(--success-rgb), 0.3); }
        .diff-dark-theme .d2h-ins .d2h-code-line-ctn { color: var(--text); }
        .diff-dark-theme .d2h-ins .d2h-code-linenumber { background: rgba(var(--success-rgb), 0.16); color: var(--success); }
        .diff-dark-theme del { background: rgba(var(--danger-rgb), 0.32); color: var(--text); text-decoration: none; border-radius: 2px; }
        .diff-dark-theme ins { background: rgba(var(--success-rgb), 0.32); color: var(--text); text-decoration: none; border-radius: 2px; }
        .diff-dark-theme .d2h-info { background: var(--surface-2); color: var(--text-muted); border-color: var(--border); }
        .diff-dark-theme .d2h-code-side-line { border-left-color: var(--border); }
        .diff-dark-theme .d2h-code-side-emptyplaceholder, .diff-dark-theme .d2h-emptyplaceholder { background: var(--surface-2); }
        .diff-dark-theme .d2h-file-side-diff { overflow-x: auto; }
      `}</style>
    </div>
  );
}
