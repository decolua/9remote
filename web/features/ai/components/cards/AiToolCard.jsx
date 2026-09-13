"use client";

import { memo, useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Copy, Check, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "@/shared/components/ui/Icon";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";
import { shortenPath } from "../../lib/shortenPath";

export const AiToolCard = memo(function AiToolCard({
  id = "",
  name = "tool",
  command = "",
  input = null,
  output = "",
  error = "",
  status = "done",
  children = [],
  engine = "claude",
  workspacePath = "",
  deferred = false
}) {
  const isRunning = status === "running";
  const isError = Boolean(error || status === "error");

  // History opens collapsed: an error row is auto-opened because it matters, but a
  // screenful of them would dump every output into the DOM at once.
  const [expanded, setExpanded] = useState(isError && !deferred);
  const [copied, setCopied] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);

  useEffect(() => {
    if (isError && !deferred) setExpanded(true);
  }, [isError, deferred]);

  const isCommand = Boolean(command) || typeof input !== "string" && Boolean(input?.command);
  const pathArg = typeof input === "string" ? "" : input?.file_path || input?.notebook_path || input?.path || input?.file || "";
  // Three kinds of text, each rendered differently: a command line stays verbatim, a path
  // goes relative to the workspace and trims at the head, and everything else (a search
  // pattern, an MCP call's query) is free prose that simply wraps.
  const rawCmd = command || pathArg || (typeof input === "string"
    ? input
    : input?.command || input?.pattern || input?.query || "");
  // Workspace-relative, deep segments dropped from the head — the row has one line for
  // this text, so the shorter form is what keeps a real file name visible in it.
  const displayCmd = !isCommand && pathArg && rawCmd === pathArg ? shortenPath(rawCmd, workspacePath) : rawCmd;
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
      {/* Clean borderless 1-line tool row flush with left margin.
          Named group: a bare `group` here nests inside the message's own, so hovering
          the message lit up every tool's actions at once. */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between py-1 px-0 hover:bg-surface-2/40 cursor-pointer select-none transition-colors group/tool"
      >
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <span className="shrink-0 mt-0.5">
            {isRunning ? (
              <Loader2 size={13} className="animate-spin text-accent" />
            ) : isError ? (
              <AlertCircle size={13} className="text-danger" />
            ) : (
              <CheckCircle2 size={13} className="text-success" />
            )}
          </span>

          {/* Name and text are one inline run, not two flex items: the text picks up right
              after the name and wraps mid-line like a sentence, instead of dropping to the
              next line as a whole block and leaving the first one half empty. Only the name
              is chipped; break-all because a command or an MCP name has no space to break
              on. The chevron sits outside so it never lands inside the chip's background. */}
          <div className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed">
            {/* MCP tools are named mcp__<server>__<tool> — one unbreakable word. Never shrunk
                or clipped: the name is the point of the row. */}
            <span className="text-[10px] font-semibold text-text uppercase tracking-wider break-all px-1 py-0.5 rounded bg-surface-2/80 [box-decoration-break:clone]" title={name}>
              {name}
            </span>
            {displayCmd && (
              <>
                {" "}
                <span className="text-text-muted break-all" title={displayCmd}>{displayCmd}</span>
              </>
            )}
          </div>

          <span className="text-text-muted/50 shrink-0 self-center">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2 opacity-0 group-hover/tool:opacity-100 transition-opacity">
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
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          </button>
        </div>
      </div>

      {/* Expanded Output with subtle left accent line */}
      {expanded && (
        <div className="mt-1 ml-3.5 pl-3 border-l-2 border-border-subtle/80 bg-surface-2/20 rounded-r-brand p-2 overflow-x-auto max-h-[260px] overflow-y-auto font-mono text-[11px] select-text">
          {error && (
            <div className="text-danger mb-1.5 whitespace-pre-wrap">{error}</div>
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

      {/* Tools this one spawned, indented like the output above */}
      {expanded && children.length > 0 && (
        <div className="ml-3.5 pl-3 border-l-2 border-border-subtle/80">
          {children.map((c) => (
            <AiToolCard key={c.id} {...c} engine={engine} workspacePath={workspacePath} />
          ))}
        </div>
      )}
    </div>
  );
});
