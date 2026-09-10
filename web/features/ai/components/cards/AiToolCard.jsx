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

  const [expanded, setExpanded] = useState(isError);
  const [copied, setCopied] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  const displayCmd = command || (typeof input === "string"
    ? input
    : input?.command || input?.file_path || input?.notebook_path || input?.path || input?.file || input?.pattern || input?.query || "");
  const filePath = input?.file_path || input?.path || input?.file || "";

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
    <div className="my-1 text-xs">
      {/* Clean borderless 1-line tool row flush with left margin */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer select-none transition-colors group"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isRunning ? (
            <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
          ) : isError ? (
            <AlertCircle size={13} className="text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
          )}

          <span className="font-mono text-[10px] font-semibold text-text uppercase tracking-wider shrink-0 px-1 py-0.5 rounded bg-surface-2/80">
            {name}
          </span>

          <span className="font-mono text-[11px] text-text-muted truncate min-w-0" title={displayCmd}>
            {displayCmd}
          </span>

          <span className="text-text-muted/50 shrink-0">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {filePath && (
            <button
              type="button"
              onClick={handleOpenFile}
              className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors flex items-center gap-1"
              title="Open file in editor"
            >
              <ExternalLink size={11} />
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors"
            title="Copy output"
          >
            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          </button>
        </div>
      </div>

      {/* Expanded Output with subtle left accent line */}
      {expanded && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 bg-surface-2/20 rounded-r-brand p-2 overflow-x-auto max-h-[260px] overflow-y-auto font-mono text-[11px] select-text">
          {error && (
            <div className="text-rose-400 mb-1.5 whitespace-pre-wrap">{error}</div>
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
