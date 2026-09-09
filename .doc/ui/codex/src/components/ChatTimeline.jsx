// test-claude-web/src/components/ChatTimeline.jsx
import React, { useEffect, useRef, useState } from "react";
import { BashCard } from "./tools/BashCard.jsx";
import { DiffCard } from "./tools/DiffCard.jsx";
import { FileCard } from "./tools/FileCard.jsx";
import { QuestionCard } from "./tools/QuestionCard.jsx";
import { AgentCard } from "./tools/AgentCard.jsx";
import { SearchCard } from "./tools/SearchCard.jsx";
import { PlanModeCard } from "./tools/PlanModeCard.jsx";
import { MarkdownView } from "./MarkdownView.jsx";

function ThinkingBox({ text, isStreaming }) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="bg-purple-950/20 border border-purple-500/30 rounded-xl p-3 text-xs text-purple-300 transition-all"
    >
      <summary className="font-semibold cursor-pointer select-none flex items-center justify-between text-purple-400">
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-ping" />
          ) : (
            <span>🧠</span>
          )}
          <span>{isStreaming ? "Claude đang suy nghĩ..." : "Quá trình suy nghĩ (Thinking)"}</span>
        </div>
        <span className="text-[10px] font-mono text-purple-400/60">
          {open ? "Thu gọn ▲" : "Xem ▼"}
        </span>
      </summary>
      <div className="mt-2 pt-2 border-t border-purple-500/20 text-purple-200/80 leading-relaxed whitespace-pre-wrap font-mono text-[11px] max-h-48 overflow-y-auto">
        {text}
      </div>
    </details>
  );
}

function AssistantBubble({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative bg-slate-900/90 border border-white/10 text-slate-100 px-4 py-3 rounded-2xl rounded-bl-sm shadow-md text-sm leading-relaxed">
      {/* Copy Button on Hover */}
      <button
        onClick={handleCopy}
        title="Sao chép câu trả lời"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 px-2 py-1 bg-white/10 hover:bg-white/20 rounded-md text-[10px] font-mono text-slate-300 transition-all flex items-center gap-1 backdrop-blur-sm"
      >
        {copied ? (
          <>
            <span className="text-emerald-400">✓</span>
            <span>Đã chép</span>
          </>
        ) : (
          <>
            <span>📋</span>
            <span>Chép</span>
          </>
        )}
      </button>

      <MarkdownView content={text} />
    </div>
  );
}

export function ChatTimeline({
  messages = [],
  activeQuestion = null,
  onAnswerQuestion,
  isTurnRunning = false,
}) {
  const containerRef = useRef(null);
  const endRef = useRef(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 80;
    setIsAtBottom(atBottom);
  };

  const scrollToBottom = () => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isAtBottom) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, activeQuestion, isTurnRunning]);

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-6 flex flex-col gap-4"
      >
        {messages.map((msg, idx) => {
          if (msg.role === "system") {
            return (
              <div key={idx} className="self-center my-1 px-4 py-1.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs font-medium flex items-center gap-2 shadow-sm animate-in fade-in zoom-in-95">
                <span>{msg.text}</span>
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <div key={idx} className="self-end max-w-[85%] bg-gradient-to-r from-blue-600 to-sky-500 text-white px-4 py-2.5 rounded-2xl rounded-br-sm shadow-md text-sm leading-relaxed whitespace-pre-wrap">
                {msg.text}
              </div>
            );
          }

          const isLatestMessage = idx === messages.length - 1;

          return (
            <div key={idx} className="self-start max-w-[90%] w-full flex flex-col gap-2">
              {/* Thinking Box */}
              {msg.thinking && (
                <ThinkingBox
                  text={msg.thinking}
                  isStreaming={isTurnRunning && isLatestMessage}
                />
              )}

              {/* Tool Calls */}
              {(msg.tools || []).map((t, tIdx) => {
                if (t.name === "Bash") {
                  return <BashCard key={tIdx} input={t.input} result={t.result} id={t.id} />;
                }
                if (t.name === "Edit") {
                  return <DiffCard key={tIdx} input={t.input} result={t.result} />;
                }
                if (t.name === "Write" || t.name === "Read") {
                  return <FileCard key={tIdx} toolName={t.name} input={t.input} result={t.result} />;
                }
                if (t.name === "Agent" || t.name === "Workflow" || t.name === "SendMessage") {
                  return <AgentCard key={tIdx} toolName={t.name} input={t.input} result={t.result} />;
                }
                if (t.name.includes("Web") || t.name.includes("exa") || t.name.includes("codegraph")) {
                  return <SearchCard key={tIdx} toolName={t.name} input={t.input} result={t.result} />;
                }
                if (t.name === "EnterPlanMode" || t.name === "ExitPlanMode") {
                  return <PlanModeCard key={tIdx} toolName={t.name} input={t.input} result={t.result} />;
                }

                return (
                  <div key={tIdx} className="tool-card p-3 rounded-lg border border-white/10 bg-black/40 text-xs text-slate-300 font-mono">
                    <div className="text-sky-400 font-semibold mb-1">⚙ {t.name}</div>
                    <pre className="text-[11px] text-slate-400 overflow-x-auto">{JSON.stringify(t.input, null, 2)}</pre>
                  </div>
                );
              })}

              {/* Assistant Text Bubble with Rich Markdown */}
              {msg.text && <AssistantBubble text={msg.text} />}
            </div>
          );
        })}

        {/* Active Question Form */}
        {activeQuestion && (
          <QuestionCard data={activeQuestion} onSubmit={onAnswerQuestion} />
        )}

        {/* Loading indicator */}
        {isTurnRunning && (
          <div className="self-start text-xs text-slate-400 italic flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
            <span>Claude đang xử lý...</span>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Floating Scroll to Bottom Button */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 px-3 py-1.5 rounded-full bg-blue-600/90 hover:bg-blue-600 text-white text-xs font-medium shadow-lg backdrop-blur-md flex items-center gap-1.5 animate-in fade-in slide-in-from-bottom-2 transition-all"
        >
          <span>↓</span>
          <span>Mới nhất</span>
        </button>
      )}
    </div>
  );
}
