"use client";

import { memo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Copy, Check, AlertCircle, Loader2, CheckCircle2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { shellIdFromResult } from "../../lib/shellId";
import { useAiPaneScope, anchorId } from "../PaneScope";

export const AiBashCard = memo(function AiBashCard({
  id = "",
  name = "Bash",
  input = null,
  output = "",
  error = "",
  status = "done",
  deferred = false
}) {
  const { sessionId: paneSessionId } = useAiPaneScope();
  const isRunning = status === "running";
  const isError = Boolean(error || status === "error");
  // History opens collapsed: an error row is auto-opened because it matters, but a
  // screenful of them would dump every output into the DOM at once.
  const [expanded, setExpanded] = useState(isError && !deferred);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);

  useEffect(() => {
    if (isError && !deferred) setExpanded(true);
  }, [isError, deferred]);

  const command = input?.command || "";
  const description = input?.description || "";
  const rawContent = error || output || "";
  const content = typeof rawContent === "string" ? rawContent : rawContent ? JSON.stringify(rawContent, null, 2) : "";

  // A background shell's tool_result arrives the moment the shell is spawned —
  // "Command running in background with ID: b367hw0hy" — so the row would read ✓
  // while the command is still going. Either half of the evidence can be missing:
  // the flag on a row that just started, the id on a row whose result already merged
  // in and overwrote the input.
  const shellId = shellIdFromResult(output);
  const isBackground = Boolean(input?.run_in_background || shellId);
  // The row's own status is the only claim that the shell is still going. The launch ack
  // above sits in the output forever, so treating it as "live" left a shell that had
  // ended — or one an agent restart had already settled — spinning for good. What ends
  // it is the harness's own task record (see aiStore.settleTasks).
  const showRunning = isRunning;

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
    <div className="my-1 text-xs" id={anchorId(paneSessionId, "shell", id)}>
      {/* $ command, capped at two lines. Named group — see AiToolCard: a bare `group`
          nested in the message's own made every tool's actions appear on message hover. */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-start justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer data-pane-control select-none transition-colors group/tool"
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <span className="shrink-0 mt-0.5">
            {showRunning ? (
              <Loader2 size={13} className="animate-spin text-accent" />
            ) : isError ? (
              <AlertCircle size={13} className="text-danger" />
            ) : (
              <CheckCircle2 size={13} className="text-success" />
            )}
          </span>
          <span className="text-text-muted select-none shrink-0 font-mono text-[11px] leading-relaxed">$</span>
          <span className="font-mono text-[11px] leading-relaxed text-text line-clamp-2 min-w-0" title={command}>
            {command || name}
          </span>
          {isBackground && (
            <span
              className="font-mono text-[10px] font-semibold text-warning shrink-0 px-1 py-0.5 rounded bg-warning/10"
              title={shellId ? `Background shell ${shellId}` : "Running in the background"}
            >
              BG{shellId ? ` ${shellId}` : ""}
            </span>
          )}
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
