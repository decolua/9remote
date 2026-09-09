"use client";

import { memo, useState, useEffect } from "react";
import { HelpCircle, Check, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

export const AiQuestionCard = memo(function AiQuestionCard({
  requestId = "",
  questions = [],
  onResolve
}) {
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [otherText, setOtherText] = useState({});
  const [submitted, setSubmitted] = useState(false);

  // Keyboard shortcut listener (1-9 to select options)
  useEffect(() => {
    if (submitted) return;
    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in an input
      if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
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
    vibrate();
    if (!multiSelect) {
      setSelectedAnswers((prev) => ({ ...prev, [qText]: optLabel }));
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
    vibrate();
    setSubmitted(true);
    onResolve?.(requestId, selectedAnswers);
  };

  if (submitted) {
    return (
      <div className="my-2 p-3 rounded-brand-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs font-medium flex items-center gap-2">
        <Check size={14} />
        <span>Selected:</span>
        <span className="font-mono text-text">{Object.values(selectedAnswers).join("; ")}</span>
      </div>
    );
  }

  return (
    <div className="my-3 p-4 rounded-brand-lg border border-amber-500/30 bg-surface shadow-sm text-xs select-none">
      <div className="flex items-center gap-2 mb-3 text-amber-400 font-semibold text-sm">
        <HelpCircle size={16} />
        <span>Claude needs your input</span>
      </div>

      <div className="space-y-4">
        {questions.map((q, qIdx) => {
          const currentAnswer = selectedAnswers[q.question] || "";
          const selectedList = q.multiSelect && currentAnswer ? currentAnswer.split(", ") : [currentAnswer];

          return (
            <div key={qIdx} className="flex flex-col gap-2">
              <div className="text-sm font-medium text-text">
                {q.question}
                {q.multiSelect && <span className="text-text-muted text-xs ml-1.5">(Select multiple)</span>}
              </div>

              {/* Options list */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                {q.options?.map((opt, optIdx) => {
                  const isSelected = selectedList.includes(opt.label);
                  return (
                    <button
                      key={optIdx}
                      type="button"
                      onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                      className={`px-3 py-2.5 rounded-brand border text-left flex items-start gap-2.5 transition-all ${
                        isSelected
                          ? "border-brand-500 bg-brand-500/15 text-text shadow-sm"
                          : "border-border-subtle bg-bg hover:bg-surface-2 text-text-muted hover:text-text"
                      }`}
                    >
                      <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted font-bold shrink-0 mt-0.5">
                        {optIdx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-xs text-text">{opt.label}</div>
                        {opt.description && (
                          <div className="text-[11px] text-text-muted mt-0.5 leading-snug">{opt.description}</div>
                        )}
                      </div>
                      {isSelected && <Check size={14} className="text-brand-500 shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
              </div>

              {/* Other option input */}
              <div className="mt-1">
                <input
                  type="text"
                  value={otherText[q.question] || ""}
                  onChange={(e) => handleOther(q.question, e.target.value)}
                  placeholder="Other (type custom answer)..."
                  className="w-full px-3 py-1.5 rounded-brand bg-bg border border-border-subtle text-xs text-text placeholder-text-muted focus:outline-none focus:border-brand-500 font-sans"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Submit Button */}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`px-4 py-2 rounded-brand flex items-center gap-1.5 font-medium transition-colors ${
            canSubmit
              ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm"
              : "bg-surface-2 text-text-muted cursor-not-allowed opacity-50"
          }`}
        >
          <span>Submit Answer</span>
          <CornerDownLeft size={13} />
        </button>
      </div>
    </div>
  );
});
