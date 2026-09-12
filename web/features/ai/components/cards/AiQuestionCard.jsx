"use client";

import { memo, useState, useEffect, useRef, useCallback } from "react";
import { HelpCircle, Check, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { parseAnswered } from "../../lib/parseAnswered";

export const AiQuestionCard = memo(function AiQuestionCard({
  requestId = "",
  questions = [],
  answers = null, // past answer: raw host text, or {question: answer}
  onResolve
}) {
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [otherText, setOtherText] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; });

  const handleSubmit = useCallback(() => {
    // `answers` only ever arrives on a replayed card — guard via ref so this
    // callback stays stable for the key listener below.
    if (answersRef.current || submitted) return;
    if (!questions.every((q) => Boolean(selectedAnswers[q.question]))) return;
    vibrate();
    setSubmitted(true);
    onResolve?.(requestId, selectedAnswers);
  }, [questions, selectedAnswers, submitted, requestId, onResolve]);

  // Keyboard shortcuts: 1-9 select an option; Enter submits from anywhere
  useEffect(() => {
    if (submitted || answers) return;
    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in an input
      if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
      if (e.key === "Enter") { e.preventDefault(); handleSubmit(); return; }
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9 && questions[0]?.options?.[num - 1]) {
        const opt = questions[0].options[num - 1];
        handleSelect(questions[0].question, opt.label, questions[0].multiSelect);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [questions, selectedAnswers, submitted, answers, handleSubmit]);

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

  // Answered view: this client's own submit, or an answer replayed from the host.
  const past = answers ? (typeof answers === "string" ? parseAnswered(answers) : answers) : null;
  if (submitted || answers) {
    return (
      <div className="my-2 p-3 rounded-brand-lg border border-success/30 bg-success/10 text-xs font-medium flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-success">
          <Check size={14} />
          <span>Answered</span>
        </div>
        {questions.map((q, idx) => {
          const a = past?.[q.question] ?? selectedAnswers[q.question];
          if (!a) return null;
          return (
            <div key={idx} className="flex flex-col gap-0.5">
              <span className="text-text-muted">{q.question}</span>
              <span className="font-mono text-text">{a}</span>
            </div>
          );
        })}
        {/* Unparseable host text still beats showing nothing */}
        {!past && !Object.keys(selectedAnswers).length && (
          <span className="font-mono text-text">{String(answers)}</span>
        )}
      </div>
    );
  }

  return (
    <div className="my-3 p-3 rounded-brand-lg border border-warning/30 bg-surface shadow-sm text-xs select-none">
      <div className="flex items-center gap-2 mb-2 text-warning font-semibold text-xs">
        <HelpCircle size={14} />
        <span>Claude needs your input</span>
      </div>

      <div className="space-y-3">
        {questions.map((q, qIdx) => {
          const currentAnswer = selectedAnswers[q.question] || "";
          const selectedList = q.multiSelect && currentAnswer ? currentAnswer.split(", ") : [currentAnswer];

          return (
            <div key={qIdx} className="flex flex-col gap-1.5">
              <div className="text-xs font-medium text-text leading-snug">
                {q.question}
                {q.multiSelect && <span className="text-text-muted text-[10px] ml-1">(multi)</span>}
              </div>

              {/* Compact option list */}
              <div className="flex flex-col gap-1">
                {q.options?.map((opt, optIdx) => {
                  const isSelected = selectedList.includes(opt.label);
                  return (
                    <button
                      key={optIdx}
                      type="button"
                      onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                      className={`px-2.5 py-1.5 rounded-brand border text-left flex items-start gap-2 transition-all text-[11px] ${
                        isSelected
                          ? "border-brand-500 bg-brand-500/15 text-text"
                          : "border-border-subtle bg-bg hover:bg-surface-2 text-text-muted hover:text-text"
                      }`}
                    >
                      <span className="font-mono text-[10px] px-1 py-0 rounded bg-surface-2 text-text-muted font-bold shrink-0">
                        {optIdx + 1}
                      </span>
                      {/* Label owns its line; the description drops below it so neither truncates. */}
                      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="font-medium text-text">{opt.label}</span>
                        {opt.description && (
                          <span className="text-[10px] text-text-muted leading-snug">{opt.description}</span>
                        )}
                      </span>
                      {isSelected && <Check size={12} className="text-brand-500 shrink-0 mt-0.5" />}
                    </button>
                  );
                })}
              </div>

              {/* Other option input */}
              <input
                type="text"
                value={otherText[q.question] || ""}
                onChange={(e) => handleOther(q.question, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (e.nativeEvent?.isComposing || e.keyCode === 229) return; // IME commit
                  e.preventDefault();
                  handleSubmit();
                }}
                placeholder="Other (type custom answer)..."
                className="w-full px-2.5 py-1 rounded-brand bg-bg border border-border-subtle text-[11px] text-text placeholder-text-muted focus:outline-none focus:border-brand-500 font-sans"
              />
            </div>
          );
        })}
      </div>

      {/* Submit Button — compact, right-aligned */}
      <div className="mt-2.5 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`px-3 py-1.5 rounded-brand flex items-center gap-1 font-medium text-xs transition-colors ${
            canSubmit
              ? "bg-brand-500 hover:bg-brand-600 text-white shadow-sm"
              : "bg-surface-2 text-text-muted cursor-not-allowed opacity-50"
          }`}
        >
          <span>Submit</span>
          <CornerDownLeft size={11} />
        </button>
      </div>
    </div>
  );
});
