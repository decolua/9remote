"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-slim.js";
import "diff2html/bundles/css/diff2html.min.css";
import { DIFF_SIDE_BY_SIDE_BREAKPOINT } from "../constants/fileExplorer.js";
import { parseUnifiedDiff } from "../lib/unifiedDiff";

// Renders a unified-diff string. Two columns of ~40 characters each is not a diff on a
// phone, it is two columns of ellipsis — so narrow screens get full-width unified rows
// and only wide ones get side-by-side. Takes the text, not a file: the git panel shows a
// whole-repo diff, the editor a single file, and both render identically.
export default function DiffBody({ diff, compact = false, className = "" }) {
  // Side-by-side follows the WINDOW, not the container — but a compact (docked side
  // panel) render is narrow by definition, so it stays unified no matter the window.
  const [wideWindow, setWideWindow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || compact) return;
    const mq = window.matchMedia(`(min-width: ${DIFF_SIDE_BY_SIDE_BREAKPOINT}px)`);
    const apply = () => setWideWindow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [compact]);
  const sideBySide = !compact && wideWindow;

  const containerRef = useCallback((node) => {
    if (!node || !diff || !sideBySide) return;
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
  }, [diff, sideBySide]);

  const rows = useMemo(() => (sideBySide || !diff ? [] : parseUnifiedDiff(diff)), [sideBySide, diff]);

  if (sideBySide) {
    return (
      <div
        ref={containerRef}
        className={`diff-themed ${compact ? "diff-themed-compact" : "bg-surface rounded"} overflow-hidden text-sm ${className}`}
      />
    );
  }

  return (
    <div className={`w-full max-w-full overflow-hidden font-mono leading-[1.6] ${compact ? "text-[10px] leading-[1.45]" : "rounded-lg border border-border bg-surface text-[12.5px]"} ${className}`}>
      {rows.map((row, i) => {
        if (row.type === "file") {
          return <div key={i} className="px-3 py-2 bg-surface-2 text-text font-semibold break-all">{row.text}</div>;
        }
        if (row.type === "hunk") {
          return <div key={i} className="px-3 py-1 bg-surface-2/60 text-text-muted select-none break-all">{row.text}</div>;
        }
        const gutter = row.type === "add" ? row.newLn : row.type === "del" ? row.oldLn : row.newLn;
        // Tinted through theme tokens; the text itself stays text-text so it keeps
        // contrast in both light and dark.
        const bg = row.type === "add"
          ? "bg-[rgba(var(--success-rgb),0.14)]"
          : row.type === "del" ? "bg-[rgba(var(--danger-rgb),0.14)]" : "";
        const signColor = row.type === "add"
          ? "text-[var(--success)]"
          : row.type === "del" ? "text-[var(--danger)]" : "text-text-subtle";
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
  );
}
