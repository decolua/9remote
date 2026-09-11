"use client";

import { memo, useState, useEffect } from "react";
import { Terminal, ChevronDown, ChevronRight, Copy, Check, AlertCircle, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export const AiBashCard = memo(function AiBashCard({
  id = "",
  name = "Bash",
  input = null,
  output = "",
  error = "",
  status = "done"
}) {
  const isRunning = status === "running";
  const isError = Boolean(error || status === "error");
  const [expanded, setExpanded] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  const command = input?.command || "";
  const description = input?.description || "";
  const rawContent = error || output || "";
  const content = typeof rawContent === "string" ? rawContent : rawContent ? JSON.stringify(rawContent, null, 2) : "";
  const lines = content ? content.split("\n") : [];

  const handleCopyCmd = (e) => {
    e.stopPropagation();
    vibrate();
    navigator.clipboard.writeText(command);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyOut = (e) => {
    e.stopPropagation();
    vibrate();
    navigator.clipboard.writeText(content);
    setCopiedOut(true);
    setTimeout(() => setCopiedOut(false), 2000);
  };

  return (
    <div className="my-1 text-xs">
      {/* 1-line row: $ command.
          Named group — see AiToolCard: a bare `group` nested in the message's own
          made every tool's actions appear on message hover. */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer select-none transition-colors group/tool"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isRunning ? (
            <Loader2 size={13} className="animate-spin text-accent shrink-0" />
          ) : isError ? (
            <AlertCircle size={13} className="text-danger shrink-0" />
          ) : (
            <Terminal size={13} className="text-success shrink-0" />
          )}
          <span className="text-text-muted select-none shrink-0 font-mono text-[11px]">$</span>
          <span className="font-mono text-[11px] text-text truncate min-w-0" title={command}>
            {command || name}
          </span>
          {content && (
            <span className="text-text-muted/50 shrink-0">
              {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2 opacity-0 group-hover/tool:opacity-100 transition-opacity">
          {command && (
            <button
              type="button"
              onClick={handleCopyCmd}
              className="p-0.5 text-text-muted hover:text-text rounded hover:bg-surface-3 transition-colors text-[10px] flex items-center gap-0.5"
              title="Copy command"
            >
              {copiedCmd ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* Description */}
      {description && !expanded && (
        <div className="ml-7 text-[10px] text-text-muted/70 italic truncate"># {description}</div>
      )}

      {/* Expanded output */}
      {expanded && content && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 bg-surface-2/20 rounded-r-brand overflow-x-auto max-h-[260px] overflow-y-auto font-mono text-[11px] select-text relative group/out">
          {description && (
            <div className="px-2 pt-1.5 text-[10px] text-text-muted/70 italic"># {description}</div>
          )}
          <pre className={`p-2 whitespace-pre-wrap leading-relaxed ${isError ? "text-danger" : "text-text"}`}>
            {content}
          </pre>
          <button
            type="button"
            onClick={handleCopyOut}
            className="absolute top-1.5 right-1.5 p-1 rounded bg-surface-3/80 hover:bg-surface-3 text-text-muted hover:text-text opacity-0 group-hover/out:opacity-100 transition-opacity text-[10px]"
            title="Copy output"
          >
            {copiedOut ? <Check size={10} className="text-success" /> : <Copy size={10} />}
          </button>
        </div>
      )}
    </div>
  );
});
