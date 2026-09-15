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
  answers = null, // past answer: raw host text, or {question: answer}
  declined = false, // the CLI refused the question (Esc, or a stopped turn) — never an answer
  failed = false, // the last answer never reached the host — the card stays, and says so
  onResolve // (requestId, behavior, message, answers) — the host's permission signature
}) {
  const { isFocused, activate } = useAiPaneScope();
  const [selectedAnswers, setSelectedAnswers] = useState({});
  const [otherText, setOtherText] = useState({});
  const [submitted, setSubmitted] = useState(false);
  // Skipping is its own outcome, not a submitted one: reusing `submitted` made a skipped
  // card render the green "Answered" view for a question the user refused to answer.
  const [skipped, setSkipped] = useState(false);
  // One question on screen at a time: a 4-question gate rendered all at once covered
  // the whole transcript, and the user answered blind to the chat behind it.
  const [step, setStep] = useState(0);
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; });

  const current = questions[Math.min(step, questions.length - 1)];
  const isLast = step >= questions.length - 1;
  const answered = (q) => Boolean(selectedAnswers[q?.question]);
  const canAdvance = answered(current);

  const handleSubmit = useCallback(() => {
    // `answers` only ever arrives on a replayed card — guard via ref so this
    // callback stays stable for the key listener below.
    if (answersRef.current || submitted) return;
    if (!questions.every((q) => Boolean(selectedAnswers[q.question]))) return;
    vibrate();
    setSubmitted(true);
    onResolve?.(requestId, "allow", "", selectedAnswers);
  }, [questions, selectedAnswers, submitted, requestId, onResolve]);

  const handleNext = useCallback(() => {
    if (!canAdvance) return;
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
    if (submitted || skipped || answersRef.current) return;
    vibrate();
    setSkipped(true);
    onResolve?.(requestId, SKIP_BEHAVIOR, SKIP_MESSAGE);
  }, [submitted, skipped, requestId, onResolve]);

  const handleSelect = useCallback((qText, optLabel, multiSelect) => {
    vibrate();
    if (!multiSelect) {
      setSelectedAnswers((prev) => ({ ...prev, [qText]: optLabel }));
      // A single-choice question is answered the moment it is clicked, so the card moves
      // on by itself. Not on the last one: that is the whole reply, and the user still
      // wants a beat to change it or go back before submitting.
      // Picking clears a half-typed free-text answer: both write the same slot, and
      // leaving the text behind would silently override the option that was just picked.
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

  // Keyboard: 1-9 pick an option on the question in view; Enter advances (or submits
  // on the last one). Both act on the visible question, never on questions[0].
  //
  // Scoped to the focused pane. The listener is on `window` — a gate is answered from
  // anywhere on the page — but every pane stays mounted, so two panes holding a gate
  // answered the same keypress and the reply landed on a chat the user was not looking
  // at. Tapping the card activates its pane first: `panePointerHandler` swallows
  // pointer-down on a control, and this card is made of them, so the wrapper upstairs
  // would otherwise never see the tap and the keys would arm nowhere.
  const armPane = useCallback(() => {
    if (!isFocused) activate?.();
  }, [isFocused, activate]);

  useEffect(() => {
    if (!isFocused) return;
    if (submitted || skipped || answers || !current) return;
    const handleKeyDown = (e) => {
      // Don't intercept if user is typing in an input
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
  }, [current, selectedAnswers, submitted, skipped, answers, handleNext, handleSelect, isFocused]);

  const handleOther = (qText, val) => {
    setOtherText((prev) => ({ ...prev, [qText]: val }));
    setSelectedAnswers((prev) => ({ ...prev, [qText]: val }));
  };

  // Answered view: this client's own submit, or an answer replayed from the host.
  const past = answers ? (typeof answers === "string" ? parseAnswered(answers) : answers) : null;

  // A refusal replayed from the host lands on the same outcome — the CLI's own record
  // of a gate the user walked away from, which is exactly what "Skipped" says.
  if (skipped || declined) {
    return (
      <div className="my-2 p-3 rounded-brand-lg bg-surface text-[13px] flex flex-col gap-1">
        <span className="text-text-muted font-medium">Skipped</span>
        {current && <span className="text-text-muted/70 leading-snug">{current.question}</span>}
      </div>
    );
  }

  if (submitted || answers) {
    return (
      <div className="my-2 p-3 rounded-brand-lg border border-success/30 bg-success/10 text-[13px] font-medium flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-success">
          <Check size={14} />
          <span>Answered</span>
        </div>
        {questions.map((q, idx) => {
          const a = past?.[q.question] ?? selectedAnswers[q.question];
          if (!a) return null;
          return (
            <div key={idx} className="flex flex-col gap-0.5">
              <span className="text-[11px] font-normal text-text-muted leading-snug">{q.question}</span>
              <span className="font-mono text-text pl-2 border-l-2 border-success/40">{a}</span>
            </div>
          );
        })}
        {/* Unparseable host text still beats showing nothing — but only when there is
            text: `answers` is null on a card that was answered locally, and String(null)
            put the word "null" on screen. */}
        {!past && !Object.keys(selectedAnswers).length && answers != null && (
          <span className="font-mono text-text">{String(answers)}</span>
        )}
      </div>
    );
  }

  if (!current) return null;

  const currentAnswer = selectedAnswers[current.question] || "";
  const selectedList = current.multiSelect && currentAnswer ? currentAnswer.split(", ") : [currentAnswer];

  return (
    // Same tint as the answered view below, so the card reads the same before and after
    // the tap instead of changing colour under the user's finger.
    //
    // onPointerDown, not onClick: it lands before the option button's own click, so the pane
    // is active by the time the choice is applied — and it fires for a tap anywhere on the
    // card, including the empty strip between controls.
    <div
      onPointerDown={armPane}
      className="my-2 p-3 rounded-brand-lg shadow-sm text-[13px] select-none border border-success/30 bg-success/10"
    >
      {/* Same header grammar as AiPermissionCard/AiBlockedCard: icon, what this card is,
          and the tool's own badge. Without it the card opened on a bare sentence and read
          as another paragraph of the transcript rather than something waiting on a tap. */}
      <div className="flex items-center gap-2 mb-2 text-text font-medium">
        <HelpCircle size={16} className="text-success shrink-0" />
        <span>Question</span>
        {questions.length > 1 && (
          <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">
            {step + 1}/{questions.length}
          </span>
        )}
        {current.multiSelect && (
          <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted uppercase">
            multi
          </span>
        )}
      </div>

      <div className="text-text leading-snug mb-1.5">{current.question}</div>

      {/* Options are borderless rows — a list of choices, not a stack of tiles. Only the
          picked one takes a tint, so the answer reads without nine boxes on screen.
          A question the model asked with no options at all skips the list entirely and
          leaves just the box below. */}
      {current.options?.length > 0 && (
        <div className="flex flex-col">
          {current.options.map((opt, optIdx) => {
            const isSelected = selectedList.includes(opt.label);
            return (
              <button
                key={optIdx}
                type="button"
                onClick={() => handleSelect(current.question, opt.label, current.multiSelect)}
                className={`px-1.5 py-1 rounded text-left flex items-start gap-2 transition-colors text-[12px] ${
                  isSelected
                    ? "bg-brand-500/12"
                    : "text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                <span className="font-mono text-[11px] text-text-muted/70 shrink-0 mt-0.5 w-2.5">
                  {optIdx + 1}
                </span>
                {/* Label owns its line; the description drops below it so neither truncates.
                    The label carries the full text colour, the description sits well below
                    it — a two-line option otherwise read as one run-on sentence. */}
                <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className={`font-medium ${isSelected ? "text-brand-400" : "text-text"}`}>{opt.label}</span>
                  {opt.description && (
                    <span className="text-[11px] text-text-muted/70 leading-snug">{opt.description}</span>
                  )}
                </span>
                {isSelected && <Check size={12} className="text-brand-500 shrink-0 mt-0.5" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Free text is a row of the list, not behind a toggle: hiding it cost a tap on
          every question, and on an optionless one there was nothing to toggle from. */}
      <input
        type="text"
        value={otherText[current.question] || ""}
        onChange={(e) => handleOther(current.question, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (e.nativeEvent?.isComposing || e.keyCode === 229) return; // IME commit
          e.preventDefault();
          handleNext();
        }}
        placeholder="Type your answer..."
        className={`w-full px-1.5 py-1 rounded bg-bg border border-border-subtle text-[12px] text-text placeholder-text-muted/70 focus:outline-none focus:border-brand-500 ${
          current.options?.length ? "mt-1.5" : "mt-1"
        }`}
      />

      {/* One action row. The forward action is the only filled button; Skip and Back are
          quiet, and Skip says what it does — it declines, it does not answer. */}
      {failed && (
        <div className="mt-1.5 text-[12px] text-danger leading-snug">
          Not sent — the host did not answer. Try again.
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 justify-end">
        <button
          type="button"
          onClick={handleSkip}
          className="px-2 py-1 rounded text-[12px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
        >
          Skip
        </button>
        {step > 0 && (
          <button
            type="button"
            onClick={handleBack}
            className="px-2 py-1 rounded text-[12px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center gap-0.5"
          >
            <ChevronLeft size={13} />
            <span>Back</span>
          </button>
        )}
        {/* One forward action, and what it is depends on the question: a multi-select in
            the middle of the set has no way forward without this button — clicking an
            option only toggles it, and Submit stays disabled until every question is
            answered. Enter did that job on a keyboard and nothing did on a phone. */}
        <button
          type="button"
          onClick={handleNext}
          disabled={!canAdvance}
          className="px-2.5 py-1 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 text-[12px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span>{isLast ? "Submit" : "Next"}</span>
          {isLast ? <CornerDownLeft size={11} /> : <ChevronRight size={12} />}
        </button>
      </div>
    </div>
  );
});
