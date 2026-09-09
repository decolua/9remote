"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, ExternalLink } from "@/shared/components/ui/Icon";
import { AiDiffCard } from "./cards/AiDiffCard";
import { AiToolCard } from "./cards/AiToolCard";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiPlanModeCard } from "./cards/AiPlanModeCard";
import { AiThinkingBlock } from "./cards/AiThinkingBlock";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { vibrate } from "@/shared/utils/vibration";

function CodeBlock({ className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";
  const codeString = String(children).replace(/\n$/, "");

  const handleCopy = () => {
    vibrate();
    navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-2 rounded-brand overflow-hidden border border-border-subtle bg-bg font-mono text-xs">
      <div className="px-3 py-1 bg-surface-2/60 flex items-center justify-between text-[11px] text-text-muted select-none border-b border-border-subtle">
        <span>{lang || "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="p-1 hover:text-text rounded flex items-center gap-1 transition-colors"
          title="Copy code"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="p-3 overflow-x-auto text-[12px] leading-relaxed text-text select-text">
        <code className={className} {...props}>
          {children}
        </code>
      </div>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onResolvePermission
}) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);
  const { role, content, thinking, diffs = [], tools = [], permission = null, isLive = false } = message;

  const handleCopyAll = () => {
    vibrate();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopiedMsg(true);
    setTimeout(() => setCopiedMsg(false), 2000);
  };

  if (role === "user") {
    return (
      <div className="flex justify-end my-3">
        <div className="max-w-[85%] sm:max-w-[75%] px-4 py-2.5 rounded-brand-lg bg-surface-2 text-text text-sm whitespace-pre-wrap break-words shadow-sm">
          {content}
        </div>
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
                  // react-markdown v10 dropped the `inline` prop — detect block code
                  // by language class or multiline content instead
                  pre({ children }) {
                    return <>{children}</>;
                  },
                  code({ className, children, ...props }) {
                    const raw = String(children ?? "");
                    const isBlock = /language-/.test(className || "") || raw.includes("\n");
                    if (!isBlock) {
                      return (
                        <code className="px-1.5 py-0.5 rounded bg-surface-2 font-mono text-[12px] text-text" {...props}>
                          {children}
                        </code>
                      );
                    }
                    return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
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
          <div className="py-2">
            <span className="inline-block w-1.5 h-4 bg-brand-500 animate-pulse" />
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
