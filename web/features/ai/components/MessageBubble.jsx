"use client";

import { memo, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, ExternalLink, Pencil } from "@/shared/components/ui/Icon";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiToolCard } from "./cards/AiToolCard";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiPlanModeCard } from "./cards/AiPlanModeCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

function CodePre({ children }) {
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
        className="bg-surface-2/50 border border-border-subtle/70 rounded-brand p-3 overflow-x-auto font-mono text-[12px] leading-relaxed text-text select-text"
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
  onResolvePermission,
  onRewind
}) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);
  const { id, role, content, thinking, diffs = [], tools = [], permission = null, isLive = false } = message;

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
      <div className="group flex justify-end my-3">
        <div className="max-w-[85%] sm:max-w-[75%] px-4 py-2.5 rounded-brand-lg bg-surface-2 text-text text-sm whitespace-pre-wrap break-words shadow-sm">
          {content}
        </div>
        <button
          type="button"
          onClick={() => { vibrate(); setEditValue(content || ""); setEditing(true); }}
          className="opacity-0 group-hover:opacity-100 p-1.5 text-text-muted hover:text-text rounded transition-all self-start mt-1"
          title="Edit & rewind"
        >
          <Pencil size={12} />
        </button>
      </div>
    );
  }

  // Assistant message
  const visibleTools = (tools || []).filter((t) => {
    if (t.name === "AskUserQuestion") return false;
    const path = t.input?.file_path || t.input?.path || "";
    if ((t.name === "Edit" || t.name === "Write") && path && diffs.some((d) => d.file === path)) {
      return false;
    }
    return true;
  });

  return (
    <div className="group relative flex justify-start my-3">
      <div className="w-full text-text text-sm leading-relaxed min-w-0">
        {/* Thinking stream block */}
        {thinking && <AiThinkingBlock text={thinking} isLive={isLive && !content} />}

        {/* Tools executions & Plan Mode cards */}
        {visibleTools.length > 0 && (
          <div className="my-1.5 space-y-1.5">
            {visibleTools.map((t, idx) => {
              if (t.name === "EnterPlanMode" || t.name === "ExitPlanMode") {
                return <AiPlanModeCard key={t.id || idx} toolName={t.name} input={t.input} />;
              }
              return <AiToolCard key={t.id || idx} {...t} />;
            })}
          </div>
        )}

        {/* Diffs */}
        {diffs && diffs.length > 0 && (
          <div className="my-1.5 space-y-1.5">
            {diffs.map((d, idx) => (
              <AiDiffCard key={d.file || idx} {...d} />
            ))}
          </div>
        )}

        {/* Text Content */}
        {content ? (
          <div className="relative">
            <div className="prose prose-invert max-w-none text-sm break-words overflow-x-auto leading-relaxed">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: CodePre,
                  code({ className, children, ...props }) {
                    const isBlock = /language-/.test(className || "");
                    if (isBlock) {
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <code className="px-1.5 py-0.5 rounded bg-surface-2 font-mono text-[12px] text-text" {...props}>
                        {children}
                      </code>
                    );
                  },
                  a({ href, children, ...props }) {
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
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:underline" {...props}>
                        {children}
                      </a>
                    );
                  }
                }}
              >
                {content}
              </ReactMarkdown>
              {isLive && <span className="inline-block w-1.5 h-3.5 bg-brand-500 animate-pulse ml-1 align-middle" />}
            </div>

            {/* Quick action bar on message hover */}
            {!isLive && (
              <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
        ) : isLive && !thinking && tools.length === 0 ? (
          <div className="flex items-center gap-2 py-2 select-none">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2/60 border border-border-subtle/50 backdrop-blur-sm shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce" />
              <span className="text-[11px] font-mono text-text-muted ml-1">AI is thinking...</span>
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
