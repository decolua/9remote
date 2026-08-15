"use client";

import { useMemo } from "react";
import { createCachedDiff } from "@/features/agentChat/lib/diff";
import { OUTPUT_MAX_HEIGHT } from "@/features/agentChat/constants/agentChatConfig";

const diffCache = createCachedDiff();

const basename = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

// Unified, changed lines only. A one-line edit in a long file stays one screen line.
export default function ToolDiffView({ filePath, oldContent, newContent, isNew, onOpenFile }) {
  const rows = useMemo(() => diffCache(oldContent || "", newContent || ""), [oldContent, newContent]);
  if (!rows.length) return null;

  return (
    <div className="overflow-hidden rounded-[10px] border border-border-subtle">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => onOpenFile?.(filePath)}
          disabled={!onOpenFile}
          className="min-w-0 truncate font-mono text-[11px] text-brand-500 disabled:text-text-muted enabled:hover:underline"
          title={filePath}
        >
          {basename(filePath)}
        </button>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${
            isNew ? "bg-success/12 text-success" : "bg-surface-3 text-text-muted"
          }`}
        >
          {isNew ? "new" : "edit"}
        </span>
      </div>

      <div className="overflow-auto font-mono text-[11px] leading-[18px]" style={{ maxHeight: OUTPUT_MAX_HEIGHT }}>
        {rows.map((row, i) => {
          const removed = row.type === "removed";
          return (
            <div key={`${row.type}-${row.lineNum}-${i}`} className="flex">
              <span
                className={`w-6 shrink-0 select-none text-center ${
                  removed ? "bg-danger/15 text-danger" : "bg-success/15 text-success"
                }`}
              >
                {removed ? "-" : "+"}
              </span>
              <span
                className={`flex-1 whitespace-pre-wrap break-all px-2 ${
                  removed ? "bg-danger/8 text-text" : "bg-success/8 text-text"
                }`}
              >
                {row.content || " "}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
