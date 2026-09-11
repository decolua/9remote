"use client";

import { memo, useState } from "react";
import { FileCode, ChevronDown, ChevronRight, Copy, Check, ExternalLink } from "@/shared/components/ui/Icon";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

export const AiDiffCard = memo(function AiDiffCard({ file = "", patch = "", diff = "", content = "" }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);

  // A whole-file add has no patch text, only the new content — show it all as additions
  const isNewFile = !patch && !diff && Boolean(content);
  const rawDiff = patch || diff || (isNewFile ? String(content).split("\n").map((l) => `+${l}`).join("\n") : "");
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
    <div className="my-1 text-xs">
      {/* Clean borderless 1-line diff row flush with left margin.
          Named group — see AiToolCard: a bare `group` nested in the message's own
          made every tool's actions appear on message hover. */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer select-none transition-colors group/tool"
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={13} className="text-brand-500 shrink-0" />
          <span className="font-mono font-medium text-text text-[11px] truncate" title={file}>
            {fileName}
          </span>
          {(additions > 0 || deletions > 0) && (
            <span className="flex items-center gap-1 font-mono text-[10px] shrink-0 text-text-muted">
              {additions > 0 && <span className="text-success">+{additions}</span>}
              {deletions > 0 && <span className="text-danger">-{deletions}</span>}
            </span>
          )}
          <span className="text-text-muted/50 shrink-0">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2 opacity-0 group-hover/tool:opacity-100 transition-opacity">
          {file && (
            <button
              type="button"
              onClick={handleOpenFile}
              className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors flex items-center gap-1 text-[10px]"
              title="Open file in editor"
            >
              <ExternalLink size={11} />
              <span className="hidden sm:inline">Open</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors"
            title="Copy diff"
          >
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          </button>
        </div>
      </div>

      {/* Indented Diff Content */}
      {expanded && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 bg-surface-2/20 rounded-r-brand p-2 overflow-x-auto max-h-[300px] overflow-y-auto font-mono text-[11px] leading-relaxed select-text">
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
                cls = "text-success";
                bgCls = "bg-success/10";
              } else if (isDel) {
                cls = "text-danger";
                bgCls = "bg-danger/10";
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
