"use client";

import { memo, useState } from "react";
import { FileCode, ChevronDown, ChevronRight, Copy, Check, ExternalLink } from "@/shared/components/ui/Icon";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

export const AiDiffCard = memo(function AiDiffCard({ file = "", patch = "", diff = "" }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);

  const rawDiff = patch || diff || "";
  const lines = rawDiff ? rawDiff.split("\n") : [];
  const fileName = file ? file.split("/").pop() : "diff";

  const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  const handleOpenFile = (e) => {
    e.stopPropagation();
    vibrate();
    if (file) openEditorFile(file);
  };

  const handleCopy = (e) => {
    e.stopPropagation();
    vibrate();
    if (!rawDiff) return;
    navigator.clipboard.writeText(rawDiff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-1.5 rounded-brand border border-border-subtle bg-surface overflow-hidden text-xs">
      {/* 1-Line Compact Header (9cowork style) */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="h-8 px-2.5 bg-surface-2/40 hover:bg-surface-2 flex items-center justify-between cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text-muted shrink-0">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <FileCode size={13} className="text-brand-500 shrink-0" />
          <span className="font-mono font-medium text-text text-[11px] truncate" title={file}>
            {fileName}
          </span>
          {(additions > 0 || deletions > 0) && (
            <span className="flex items-center gap-1 font-mono text-[10px] shrink-0">
              {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
              {deletions > 0 && <span className="text-rose-400">-{deletions}</span>}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          {file && (
            <button
              type="button"
              onClick={handleOpenFile}
              className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors flex items-center gap-1 text-[11px]"
              title="Open file in editor"
            >
              <ExternalLink size={12} />
              <span className="hidden sm:inline text-[10px]">Open</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors"
            title="Copy diff"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {/* Expandable Diff Content */}
      {expanded && (
        <div className="p-2 border-t border-border-subtle overflow-x-auto max-h-[320px] overflow-y-auto font-mono text-[11px] leading-relaxed bg-bg select-text">
          {lines.length === 0 ? (
            <div className="text-text-muted italic py-1 px-2">No changes</div>
          ) : (
            lines.map((line, idx) => {
              const isAdd = line.startsWith("+") && !line.startsWith("+++");
              const isDel = line.startsWith("-") && !line.startsWith("---");
              const isHunk = line.startsWith("@@");

              let cls = "text-text";
              let bgCls = "";
              if (isAdd) {
                cls = "text-emerald-400";
                bgCls = "bg-emerald-500/10";
              } else if (isDel) {
                cls = "text-rose-400";
                bgCls = "bg-rose-500/10";
              } else if (isHunk) {
                cls = "text-text-muted";
                bgCls = "bg-surface-2/40";
              }

              return (
                <div key={idx} className={`px-2 py-0.5 rounded-sm whitespace-pre ${cls} ${bgCls}`}>
                  {line}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
});
