"use client";

import { memo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Copy, Check, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "@/shared/components/ui/Icon";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

export const AiToolCard = memo(function AiToolCard({
  id = "",
  name = "tool",
  command = "",
  input = null,
  output = "",
  error = "",
  status = "done"
}) {
  const isRunning = status === "running";
  const isError = Boolean(error || status === "error");

  // Default collapsed like 9cowork; only auto-expand on error
  const [expanded, setExpanded] = useState(isError);
  const [copied, setCopied] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  const displayCmd = command || (typeof input === "string" ? input : input?.command || input?.path || input?.file || "");
  const filePath = input?.path || input?.file || "";

  const handleCopy = (e) => {
    e.stopPropagation();
    vibrate();
    const content = output || error || displayCmd;
    if (!content) return;
    navigator.clipboard.writeText(typeof content === "string" ? content : JSON.stringify(content, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenFile = (e) => {
    e.stopPropagation();
    vibrate();
    if (filePath) openEditorFile(filePath);
  };

  return (
    <div className="my-1.5 rounded-brand border border-border-subtle bg-surface overflow-hidden text-xs">
      {/* 1-Line Compact Header (9cowork style) */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="h-8 px-2.5 bg-surface-2/30 hover:bg-surface-2 flex items-center justify-between cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-text-muted shrink-0">
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>

          {isRunning ? (
            <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
          ) : isError ? (
            <AlertCircle size={13} className="text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
          )}

          <span className="font-mono font-medium text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text uppercase tracking-wider shrink-0">
            {name}
          </span>

          <span className="font-mono text-[11px] text-text-muted truncate min-w-0" title={displayCmd}>
            {displayCmd}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          {filePath && (
            <button
              type="button"
              onClick={handleOpenFile}
              className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors flex items-center gap-1"
              title="Open file"
            >
              <ExternalLink size={12} />
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-1 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors"
            title="Copy output"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      {/* Expandable Content */}
      {expanded && (
        <div className="p-2.5 bg-bg border-t border-border-subtle overflow-x-auto max-h-[260px] overflow-y-auto font-mono text-[11px] select-text">
          {error && (
            <div className="text-rose-400 mb-1.5 whitespace-pre-wrap">
              {error}
            </div>
          )}
          {output ? (
            <div className="text-text whitespace-pre-wrap leading-relaxed">
              {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
            </div>
          ) : !error ? (
            <div className="text-text-muted italic">Running or no output returned...</div>
          ) : null}
        </div>
      )}
    </div>
  );
});
