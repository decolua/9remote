// test-claude-web/src/components/ChatTimeline.jsx
import React, { useEffect, useRef } from "react";
import { BashCard } from "./tools/BashCard.jsx";
import { DiffCard } from "./tools/DiffCard.jsx";
import { FileCard } from "./tools/FileCard.jsx";
import { QuestionCard } from "./tools/QuestionCard.jsx";

export function ChatTimeline({
  messages = [],
  activeQuestion = null,
  onAnswerQuestion,
  isTurnRunning = false,
}) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeQuestion, isTurnRunning]);

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
      {messages.map((msg, idx) => {
        if (msg.role === "user") {
          return (
            <div key={idx} className="self-end max-w-[85%] bg-gradient-to-r from-blue-600 to-sky-500 text-white px-4 py-2.5 rounded-2xl rounded-br-sm shadow-md text-sm leading-relaxed whitespace-pre-wrap">
              {msg.text}
            </div>
          );
        }

        return (
          <div key={idx} className="self-start max-w-[90%] w-full flex flex-col gap-2">
            {/* Thinking Box */}
            {msg.thinking && (
              <details className="bg-slate-900/60 border border-purple-500/30 rounded-xl p-3 text-xs text-purple-300">
                <summary className="font-semibold cursor-pointer select-none flex items-center gap-2 text-purple-400">
                  <span>🧠</span> Suy nghĩ (Thinking)
                </summary>
                <div className="mt-2 pt-2 border-t border-purple-500/20 text-purple-200/80 leading-relaxed whitespace-pre-wrap font-mono text-[11px] max-h-36 overflow-y-auto">
                  {msg.thinking}
                </div>
              </details>
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
              return (
                <div key={tIdx} className="tool-card p-3 rounded-lg border border-white/10 bg-black/40 text-xs text-slate-300 font-mono">
                  <div className="text-sky-400 font-semibold mb-1">⚙ {t.name}</div>
                  <pre className="text-[11px] text-slate-400 overflow-x-auto">{JSON.stringify(t.input, null, 2)}</pre>
                </div>
              );
            })}

            {/* Assistant Text Bubble */}
            {msg.text && (
              <div className="bg-slate-900/90 border border-white/10 text-slate-100 px-4 py-3 rounded-2xl rounded-bl-sm shadow-md text-sm leading-relaxed whitespace-pre-wrap">
                {msg.text}
              </div>
            )}
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
  );
}
