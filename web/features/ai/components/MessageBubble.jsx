"use client";

import { memo, useState, useRef } from "react";
import MarkdownBody from "@/shared/components/ui/MarkdownBody";
import { Copy, Check, ExternalLink, Pencil, Loader2 } from "@/shared/components/ui/Icon";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiToolCard } from "./cards/AiToolCard";
import { AiBashCard } from "./cards/AiBashCard";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiPlanModeCard } from "./cards/AiPlanModeCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { getToolCategory } from "../registry";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

// Tools whose whole effect is the pinned checklist strip (AiTaskCard) — inline they
// would only repeat it. The rest of the "task" category is a plain row (see below).
const TASK_STRIP_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "todowrite"]);

function CodePre({ children, node: _node, ...props }) {
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  const handleCopy = () => {
    vibrate();
    const text = ref.current?.textContent || "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group/code my-2.5">
      <pre
        ref={ref}
        className="bg-surface-2/50 border border-border-subtle/70 rounded-brand p-3 overflow-x-auto max-w-full font-mono text-[12px] leading-relaxed text-text select-text [&_code]:bg-transparent [&_code]:p-0 [&_code]:border-0"
        {...props}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded bg-surface-3/80 hover:bg-surface-3 text-text-muted hover:text-text opacity-0 group-hover/code:opacity-100 transition-opacity backdrop-blur-sm"
        title="Copy code"
      >
        {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  engine = "claude",
  workspacePath = "",
  onResolvePermission,
  onRewind
}) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);
  const { id, role, content, thinking, diffs = [], tools = [], permission = null, isLive = false } = message;
  // Same blank-run test AiThinkingBlock uses — a whitespace-only streak renders nothing,
  // so it must not count as content when deciding whether the live spinner shows either.
  const hasThinking = Boolean(thinking?.trim());

  const handleCopyAll = () => {
    vibrate();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopiedMsg(true);
    setTimeout(() => setCopiedMsg(false), 2000);
  };

  if (role === "user") {
    if (editing) {
      return (
        <div className="flex justify-end my-3">
          <div className="max-w-[85%] sm:max-w-[75%] w-full">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  if (editValue.trim()) {
                    onRewind?.(message.id, editValue.trim());
                    setEditing(false);
                  }
                }
                if (e.key === "Escape") setEditing(false);
              }}
              rows={Math.min(10, editValue.split("\n").length + 1)}
              className="w-full resize-none overflow-hidden rounded-brand-lg bg-surface-2 px-4 py-2.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand-500 leading-relaxed"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-1.5 text-[11px] text-text-muted">
              <span>Enter to save & rewind, Esc to cancel</span>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="group/msg flex justify-end my-3">
        <div className="max-w-[85%] sm:max-w-[75%] px-4 py-2.5 rounded-brand-lg bg-surface-2/70 text-text text-sm whitespace-pre-wrap break-words">
          {content}
        </div>
        <button
          type="button"
          onClick={() => { vibrate(); setEditValue(content || ""); setEditing(true); }}
          className="opacity-0 group-hover/msg:opacity-100 p-1.5 text-text-muted hover:text-text rounded transition-all self-start mt-1"
          title="Edit & rewind"
        >
          <Pencil size={12} />
        </button>
      </div>
    );
  }

  // Assistant message — route tools through registry
  const visibleTools = (tools || []).filter((t) => {
    if (!t || !t.name) return false;
    const path = t.input?.file_path || t.input?.path || "";
    if ((t.name === "Edit" || t.name === "Write") && path && diffs.some((d) => d.file === path)) {
      return false;
    }
    // Task checklist renders in the pinned strip, not inline — except TaskList/TaskGet,
    // which the strip has no equivalent of (they read the list rather than change it).
    if (getToolCategory(engine, t.name) === "task" && TASK_STRIP_TOOLS.has(t.name)) return false;
    return true;
  });

  const renderTool = (t, idx) => {
    const cat = getToolCategory(engine, t.name);
    switch (cat) {
      case "plan":
        return <AiPlanModeCard key={t.id || idx} toolName={t.name} input={t.input} />;
      case "bash":
        return <AiBashCard key={t.id || idx} {...t} />;
      // Answered question — the host's tool output is the only record of the choice.
      // While still running the pinned card above the composer owns the interaction.
      case "question":
        return t.status === "running" ? null : (
          <AiQuestionCard
            key={t.id || idx}
            questions={t.input?.questions || []}
            answers={t.output || t.error || ""}
          />
        );
      // diff/file/search/agent/task/generic → all use compact AiToolCard
      default:
        return <AiToolCard key={t.id || idx} {...t} workspacePath={workspacePath} />;
    }
  };

  return (
    <div className="relative flex justify-start my-3">
      <div className="w-full text-text text-sm leading-relaxed min-w-0">
        {/* Thinking stream block */}
        {thinking && <AiThinkingBlock text={thinking} isLive={isLive && !content} />}

        {/* Tools executions & Plan Mode cards */}
        {visibleTools.length > 0 && (
          <div className="my-1.5 space-y-1.5">
            {visibleTools.map((t, idx) => renderTool(t, idx))}
          </div>
        )}

        {/* Diffs */}
        {diffs && diffs.length > 0 && (
          <div className="my-1.5 space-y-1.5">
            {diffs.map((d, idx) => (
              <AiDiffCard key={d.file || idx} {...d} workspacePath={workspacePath} />
            ))}
          </div>
        )}

        {/* Text Content */}
        {content ? (
          // Own group: hovering the prose reveals the copy bar, and nothing else
          <div className="group/msg relative">
            <div className="max-w-none min-w-0 text-sm break-words leading-relaxed">
              <MarkdownBody
                content={content}
                components={{
                  pre: CodePre,
                  // Relative links open in the editor; `node` must not reach the DOM
                  a({ href, children, className, node: _node, ...props }) {
                    const isRelativeFile = href && !href.startsWith("http://") && !href.startsWith("https://");
                    if (isRelativeFile) {
                      return (
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            openEditorFile(href);
                          }}
                          className="text-brand-500 hover:underline inline-flex items-center gap-0.5 cursor-pointer font-medium"
                          {...props}
                        >
                          {children}
                          <ExternalLink size={11} className="inline ml-0.5" />
                        </a>
                      );
                    }
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`text-brand-500 hover:underline${className ? ` ${className}` : ""}`}
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  }
                }}
              />
              {isLive && <span className="inline-block w-1.5 h-3.5 bg-brand-500 animate-pulse ml-1 align-middle" />}
            </div>

            {/* Quick action bar on message hover */}
            {!isLive && (
              <div className="flex items-center gap-1 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={handleCopyAll}
                  className="px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1 transition-colors"
                  title="Copy full message"
                >
                  {copiedMsg ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  <span>{copiedMsg ? "Copied" : "Copy text"}</span>
                </button>
              </div>
            )}
          </div>
        ) : isLive && !hasThinking && tools.length === 0 ? (
          <div className="flex items-center gap-2 py-2 select-none">
            <div className="w-7 h-7 rounded-full flex items-center justify-center bg-surface-2/70 border border-border-subtle/60 shadow-sm backdrop-blur-sm">
              <Loader2 size={14} className="animate-spin text-brand-500" />
            </div>
          </div>
        ) : null}

        {/* Inline Permission or AskUserQuestion Card */}
        {permission && (
          permission.tool === "AskUserQuestion" ? (
            <AiQuestionCard
              requestId={permission.requestId}
              questions={permission.input?.questions || []}
              onResolve={(reqId, answers) => onResolvePermission?.(reqId, "allow", "", answers)}
            />
          ) : (
            <AiPermissionCard
              requestId={permission.requestId}
              tool={permission.tool}
              input={permission.input}
              onResolve={onResolvePermission}
            />
          )
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.message === next.message && prev.onResolvePermission === next.onResolvePermission) return true;
  // Freezed comparison for completed messages
  if (!prev.message.isLive && !next.message.isLive) {
    return (
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.thinking === next.message.thinking &&
      prev.message.permission === next.message.permission &&
      prev.message.tools?.length === next.message.tools?.length &&
      prev.message.diffs?.length === next.message.diffs?.length &&
      prev.onResolvePermission === next.onResolvePermission
    );
  }
  return false;
});
