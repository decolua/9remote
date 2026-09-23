"use client";

import { memo, useState, useEffect, useRef, useCallback } from "react";
import { HelpCircle, Check, ChevronLeft, ChevronRight, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { parseAnswered } from "../../lib/parseAnswered";
import { SKIP_BEHAVIOR, SKIP_MESSAGE } from "../../constants";
import { useAiPaneScope } from "../PaneScope";

export const AiQuestionCard = memo(function AiQuestionCard({
  requestId = "",
  questions = [],
  answers = null,
  declined = false,
  failed = false,
  onResolve,
  engine = ""
}) {
  const { isFocused, activate } = useAiPaneScope();
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [otherText, setOtherText] = useState({});
  const [inFlight, setInFlight] = useState(false);
  const [typing, setTyping] = useState(false);
  const [step, setStep] = useState(0);

  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; });
  const declinedRef = useRef(declined);
  useEffect(() => { declinedRef.current = declined; });
  const inFlightRef = useRef(inFlight);
  useEffect(() => { inFlightRef.current = inFlight; });

  useEffect(() => { if (failed) { inFlightRef.current = false; setInFlight(false); } }, [failed]);

  const current = questions[Math.min(step, questions.length - 1)];
  const isLast = step >= questions.length - 1;
  const answered = (q) => Boolean(selectedAnswers[q?.question]);
  const canAdvance = answered(current) || typing;

  const handleSubmit = useCallback(() => {
    if (answersRef.current || declinedRef.current || inFlightRef.current) return;
    if (!questions.every((q) => Boolean(selectedAnswers[q.question]))) return;
    vibrate();
    inFlightRef.current = true;
    setInFlight(true);
    onResolve?.(requestId, "allow", "", selectedAnswers);
  }, [questions, selectedAnswers, requestId, onResolve]);

  const handleNext = useCallback(() => {
    if (inFlightRef.current || declinedRef.current || !canAdvance) return;
    vibrate();
    if (isLast) handleSubmit();
    else setStep((s) => s + 1);
  }, [canAdvance, isLast, handleSubmit]);

  const handleBack = useCallback(() => {
    if (step === 0) return;
    vibrate();
    setStep((s) => s - 1);
  }, [step]);

  const handleSkip = useCallback(() => {
    if (inFlightRef.current || declinedRef.current || answersRef.current) return;
    vibrate();
    inFlightRef.current = true;
    setInFlight(true);
    onResolve?.(requestId, SKIP_BEHAVIOR, SKIP_MESSAGE);
  }, [requestId, onResolve]);

  const handleSelect = useCallback((qText, optLabel, multiSelect) => {
    if (inFlightRef.current) return;
    vibrate();
    if (!multiSelect) {
      setSelectedAnswers((prev) => ({ ...prev, [qText]: optLabel }));
      setOtherText((prev) => (prev[qText] ? { ...prev, [qText]: "" } : prev));
      if (!isLast) setStep((s) => s + 1);
      return;
    }
    setSelectedAnswers((prev) => {
      const curr = prev[qText] ? prev[qText].split(", ") : [];
      const idx = curr.indexOf(optLabel);
      if (idx > -1) curr.splice(idx, 1);
      else curr.push(optLabel);
      return { ...prev, [qText]: curr.join(", ") };
    });
  }, [isLast]);

  const armPane = useCallback(() => {
    if (!isFocused) activate?.();
  }, [isFocused, activate]);

  useEffect(() => {
    if (!isFocused) return;
    if (inFlight || answers || declined || !current) return;
    const handleKeyDown = (e) => {
      if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
      if (e.key === "Enter") { e.preventDefault(); handleNext(); return; }
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 9 && current.options?.[num - 1]) {
        const opt = current.options[num - 1];
        handleSelect(current.question, opt.label, current.multiSelect);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [current, inFlight, answers, declined, handleNext, handleSelect, isFocused]);

  const handleOther = (qText, val) => {
    setOtherText((prev) => ({ ...prev, [qText]: val }));
    setSelectedAnswers((prev) => ({ ...prev, [qText]: val }));
  };

  const past = answers ? (typeof answers === "string" ? parseAnswered(answers, questions.map((q) => q.question)) : answers) : null;

  if (declined) {
    return (
      <div className="my-2 p-3 rounded-brand-lg bg-surface text-[14px] flex flex-col gap-1">
        <span className="text-text-muted font-medium">Skipped</span>
        {current && <span className="text-text-muted/70 leading-snug">{current.question}</span>}
        {/* Headless agy auto-skips every question (no answer channel exists); the TUI in
            a real terminal is the one place it waits — say so where the skip is seen. */}
        {engine === "antigravity" && (
          <span className="text-[12px] text-text-muted/60 leading-snug">
            Headless Antigravity cannot wait for an answer — open it in a terminal (new terminal → Antigravity) to answer questions interactively.
          </span>
        )}
      </div>
    );
  }

  if (answers) {
    return (
      <div className="my-2 p-3 rounded-brand-lg border border-success/30 bg-success/10 text-[14px] font-medium flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-success">
          <Check size={14} />
          <span>Answered</span>
        </div>
        {questions.map((q, idx) => {
          const a = past?.[q.question];
          if (!a) return null;
          return (
            <div key={idx} className="flex flex-col gap-0.5">
              <span className="text-[12px] font-normal text-text-muted leading-snug">{q.question}</span>
              <span className="font-mono text-text pl-2 border-l-2 border-success/40">{a}</span>
            </div>
          );
        })}
        {!past && <span className="font-mono text-text">{String(answers)}</span>}
      </div>
    );
  }

  if (!current) return null;
  if (!onResolve) return null;

  const currentAnswer = selectedAnswers[current.question] || "";
  const selectedList = current.multiSelect && currentAnswer ? currentAnswer.split(", ") : [currentAnswer];

  return (
    <div
      onPointerDown={armPane}
      className="my-2 p-3 rounded-brand-lg shadow-sm text-[14px] select-none border border-warning/30 bg-warning/[0.06]"
    >
      <div className="flex items-center gap-2 mb-2 text-warning font-medium">
        <HelpCircle size={16} className="text-warning shrink-0" />
        <span>Question</span>
        {questions.length > 1 && (
          <span className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">
            {step + 1}/{questions.length}
          </span>
        )}
        {current.multiSelect && (
          <span className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted uppercase">
            multi
          </span>
        )}
      </div>

      <div className="text-text leading-snug mb-1.5">{current.question}</div>

      {current.options?.length > 0 && (
        <div className="flex flex-col">
          {current.options.map((opt, optIdx) => {
            const isSelected = selectedList.includes(opt.label);
            return (
              <button
                key={optIdx}
                type="button"
                onClick={() => handleSelect(current.question, opt.label, current.multiSelect)}
                className={`px-1.5 py-1 rounded text-left flex items-start gap-2 transition-colors text-[13px] ${
                  isSelected
                    ? "bg-brand-500/12"
                    : "text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                <span className="font-mono text-[12px] text-text-muted/70 shrink-0 mt-0.5 w-2.5">
                  {optIdx + 1}
                </span>
                <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className={`font-medium ${isSelected ? "text-brand-400" : "text-text"}`}>{opt.label}</span>
                  {opt.description && (
                    <span className="text-[12px] text-text-muted/70 leading-snug">{opt.description}</span>
                  )}
                </span>
                {isSelected && <Check size={12} className="text-brand-500 shrink-0 mt-0.5" />}
              </button>
            );
          })}
        </div>
      )}

      <input
        type="text"
        value={otherText[current.question] || ""}
        disabled={inFlight}
        onFocus={() => setTyping(true)}
        onChange={(e) => handleOther(current.question, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          handleNext();
        }}
        placeholder="Type your answer..."
        className={`w-full px-1.5 py-1 rounded bg-bg border border-border-subtle text-[13px] text-text placeholder-text-muted/70 focus:outline-none focus:border-brand-500 disabled:opacity-40 ${
          current.options?.length ? "mt-1.5" : "mt-1"
        }`}
      />

      {failed && (
        <div className="mt-1.5 text-[13px] text-danger leading-snug">
          Not sent — the host did not answer. Try again.
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 justify-end">
        <button
          type="button"
          onClick={handleSkip}
          disabled={inFlight}
          className="px-2 py-1 rounded text-[13px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Skip
        </button>
        {step > 0 && (
          <button
            type="button"
            onClick={handleBack}
            className="px-2 py-1 rounded text-[13px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center gap-0.5"
          >
            <ChevronLeft size={13} />
            <span>Back</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleNext}
          disabled={inFlight || !canAdvance}
          className="px-2.5 py-1 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span>{isLast ? (inFlight ? "Sending…" : "Submit") : "Next"}</span>
          {isLast ? <CornerDownLeft size={11} /> : <ChevronRight size={12} />}
        </button>
      </div>
    </div>
  );
});
