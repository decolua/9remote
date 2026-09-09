// test-claude-web/src/components/tools/QuestionCard.jsx
import React, { useState, useEffect } from "react";

export function QuestionCard({ data, onSubmit }) {
  const { requestId, questions = [] } = data;
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [otherText, setOtherText] = useState({});
  const [otherActive, setOtherActive] = useState({});
  const [submitted, setSubmitted] = useState(false);

  // Keyboard shortcut listener (1-9 to select options)
  useEffect(() => {
    if (submitted) return;
    const handleKeyDown = (e) => {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9 && questions[0]?.options?.[num - 1]) {
        const opt = questions[0].options[num - 1];
        handleSelect(questions[0].question, opt.label, questions[0].multiSelect);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [questions, selectedAnswers, submitted]);

  const handleSelect = (qText, optLabel, multiSelect) => {
    if (!multiSelect) {
      setSelectedAnswers((prev) => ({ ...prev, [qText]: optLabel }));
      setOtherActive((prev) => ({ ...prev, [qText]: false }));
    } else {
      setSelectedAnswers((prev) => {
        const curr = prev[qText] ? prev[qText].split(", ") : [];
        const idx = curr.indexOf(optLabel);
        if (idx > -1) curr.splice(idx, 1);
        else curr.push(optLabel);
        return { ...prev, [qText]: curr.join(", ") };
      });
    }
  };

  const handleOther = (qText, val) => {
    setOtherText((prev) => ({ ...prev, [qText]: val }));
    setSelectedAnswers((prev) => ({ ...prev, [qText]: val }));
  };

  const canSubmit = questions.every((q) => Boolean(selectedAnswers[q.question]));

  const handleSubmit = () => {
    if (!canSubmit || submitted) return;
    setSubmitted(true);
    onSubmit(requestId, selectedAnswers);
  };

  if (submitted) {
    return (
      <div className="tool-card question-confirmed-card p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs font-semibold flex items-center gap-2">
        <span>✓ Đã chọn:</span>
        <span className="text-white font-mono">{Object.values(selectedAnswers).join(", ")}</span>
      </div>
    );
  }

  return (
    <div className="tool-card question-card p-5 rounded-xl border border-sky-500/40 bg-gradient-to-b from-slate-900/90 to-slate-950/90 shadow-2xl flex flex-col gap-4">
      {questions.map((q, qIdx) => (
        <div key={qIdx} className="flex flex-col gap-3">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400 bg-sky-500/20 px-2 py-0.5 rounded">
              {q.header || "Câu hỏi"}
            </span>
            <div className="text-sm font-semibold text-white mt-1.5 leading-snug">
              {q.question}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {(q.options || []).map((opt, optIdx) => {
              const isSelected = q.multiSelect
                ? selectedAnswers[q.question]?.includes(opt.label)
                : selectedAnswers[q.question] === opt.label;

              return (
                <div
                  key={optIdx}
                  onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                  className={`option-item flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected
                      ? "bg-sky-500/20 border-sky-500 shadow-md shadow-sky-500/10"
                      : "bg-white/[0.03] border-white/10 hover:bg-sky-500/10 hover:border-sky-500/40"
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center mt-0.5 flex-shrink-0 ${isSelected ? "border-sky-400" : "border-slate-500"}`}>
                    {isSelected && <div className="w-2 h-2 rounded-full bg-sky-400" />}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                      {opt.label}
                      <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded text-slate-400 font-mono">
                        [{optIdx + 1}]
                      </span>
                    </div>
                    {opt.description && (
                      <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                        {opt.description}
                      </div>
                    )}
                    {opt.preview && (
                      <pre className="mt-2 p-2 bg-black/60 rounded text-[10px] text-sky-300 font-mono overflow-x-auto">
                        {opt.preview}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Other option */}
            <div
              onClick={() => {
                setOtherActive((prev) => ({ ...prev, [q.question]: true }));
              }}
              className={`option-item flex flex-col gap-2 p-3 rounded-lg border cursor-pointer transition-all ${
                otherActive[q.question]
                  ? "bg-sky-500/20 border-sky-500"
                  : "bg-white/[0.03] border-white/10 hover:border-sky-500/40"
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${otherActive[q.question] ? "border-sky-400" : "border-slate-500"}`}>
                  {otherActive[q.question] && <div className="w-2 h-2 rounded-full bg-sky-400" />}
                </div>
                <span className="text-xs font-semibold text-slate-200">Khác (tự nhập)...</span>
              </div>
              {otherActive[q.question] && (
                <input
                  type="text"
                  placeholder="Nhập câu trả lời riêng..."
                  value={otherText[q.question] || ""}
                  onChange={(e) => handleOther(q.question, e.target.value)}
                  className="w-full bg-black/50 border border-white/10 rounded px-3 py-1.5 text-xs text-white outline-none focus:border-sky-500"
                  autoFocus
                />
              )}
            </div>
          </div>
        </div>
      ))}

      <button
        disabled={!canSubmit}
        onClick={handleSubmit}
        className="w-full py-2.5 rounded-lg font-semibold text-xs text-white bg-gradient-to-r from-blue-600 to-sky-500 hover:from-blue-500 hover:to-sky-400 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-sky-500/20 transition-all flex items-center justify-center gap-2"
      >
        Gửi câu trả lời cho Claude (Enter) ✓
      </button>
    </div>
  );
}
