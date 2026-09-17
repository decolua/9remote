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
  // An answer or a skip is OUT with the host and nothing has come back yet. It locks the
  // controls for the round-trip and claims nothing else: the card stays on screen, and
  // only the store taking it away — which it does on the host's own ack — says the gate
  // was answered. The version that painted the green "Answered" view from local state
  // reported success for an answer that never arrived, and the question came back on the
  // next F5. Skip shares the flag: both are a reply in flight, and neither is an outcome.
  const [inFlight, setInFlight] = useState(false);
  // The cursor in the free-text box is an answer in progress: focusing it arms the
  // forward action, so Enter acts at once — including on an empty box — instead of
  // doing nothing until a character lands. Sticky rather than cleared on blur: a
  // mousedown on Submit blurs the box first, and a button that flips to disabled in
  // that gap swallows the click (Safari never focuses a button on click, so
  // `relatedTarget` cannot tell the two blurs apart either).
  const [typing, setTyping] = useState(false);
  // One question on screen at a time: a 4-question gate rendered all at once covered
  // the whole transcript, and the user answered blind to the chat behind it.
  const [step, setStep] = useState(0);
  // The three guards the handlers below read. Kept in refs, not read off props: a
  // callback that closed over them would be a new function on every render, and the key
  // listener keyed on it would rebind mid-answer.
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; });
  const declinedRef = useRef(declined);
  useEffect(() => { declinedRef.current = declined; });
  const inFlightRef = useRef(inFlight);
  useEffect(() => { inFlightRef.current = inFlight; });

  // The host gave up on the attempt in flight — it never reached the CLI — so the
  // controls come back and it can be given again. A lock that outlived the failure left
  // reloading the page as the only way out of a gate nobody had answered.
  //
  // Every attempt re-arms this, because `resolvePermission` clears the failure as it
  // sends: the flip that lands here is always THIS attempt's own, never a stale one.
  useEffect(() => { if (failed) { inFlightRef.current = false; setInFlight(false); } }, [failed]);

  const current = questions[Math.min(step, questions.length - 1)];
  const isLast = step >= questions.length - 1;
  const answered = (q) => Boolean(selectedAnswers[q?.question]);
  const canAdvance = answered(current) || typing;

  // `answers` and `declined` are read through refs so this callback — and the key
  // listener that holds it — stay stable across renders.
  const handleSubmit = useCallback(() => {
    if (answersRef.current || declinedRef.current || inFlightRef.current) return;
    if (!questions.every((q) => Boolean(selectedAnswers[q.question]))) return;
    vibrate();
    // The ref moves with the state, not a render behind it: two taps inside one frame
    // would otherwise both pass the guard and put two answers on the wire.
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
    if (inFlight || answers || declined || !current) return;
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
  }, [current, inFlight, answers, declined, handleNext, handleSelect, isFocused]);

  const handleOther = (qText, val) => {
    setOtherText((prev) => ({ ...prev, [qText]: val }));
    setSelectedAnswers((prev) => ({ ...prev, [qText]: val }));
  };

  // An outcome replayed from the host: the answer its tool output records, or its own
  // record of a gate the user walked away from. Both are the HOST saying so — nothing
  // this card decided on its own. A card that painted either from local state reported
  // an outcome the CLI never received, and the question was back on the next reload.
  const past = answers ? (typeof answers === "string" ? parseAnswered(answers, questions.map((q) => q.question)) : answers) : null;

  if (declined) {
    return (
      <div className="my-2 p-3 rounded-brand-lg bg-surface text-[13px] flex flex-col gap-1">
        <span className="text-text-muted font-medium">Skipped</span>
        {current && <span className="text-text-muted/70 leading-snug">{current.question}</span>}
      </div>
    );
  }

  if (answers) {
    return (
      <div className="my-2 p-3 rounded-brand-lg border border-success/30 bg-success/10 text-[13px] font-medium flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-success">
          <Check size={14} />
          <span>Answered</span>
        </div>
        {questions.map((q, idx) => {
          const a = past?.[q.question];
          if (!a) return null;
          return (
            <div key={idx} className="flex flex-col gap-0.5">
              <span className="text-[11px] font-normal text-text-muted leading-snug">{q.question}</span>
              <span className="font-mono text-text pl-2 border-l-2 border-success/40">{a}</span>
            </div>
          );
        })}
        {/* Unparseable host text still beats showing nothing. */}
        {!past && <span className="font-mono text-text">{String(answers)}</span>}
      </div>
    );
  }

  if (!current) return null;

  // A card with no `onResolve` is a RECORD of a past call — the same tool rendered in the
  // transcript, which replays the call but has no gate behind it. It is not a door: it
  // used to draw the whole form, and a tap there went to `onResolve?.()` → nowhere while
  // the card painted itself answered. Nothing to answer here, so there is nothing to show.
  if (!onResolve) return null;

  const currentAnswer = selectedAnswers[current.question] || "";
  const selectedList = current.multiSelect && currentAnswer ? currentAnswer.split(", ") : [currentAnswer];

  return (
    // Waiting, not answered: the tint is the warning family, never the green of the
    // answered card — green was the old tell that promised an answer the host had not
    // taken yet, and the card only turns green once the host's own record replaces it.
    // A tinted ground rather than the plain surface: on a dark pane `bg-surface` (#171717
    // over #0a0a0a) read as a black hole with a hairline around it.
    //
    // onPointerDown, not onClick: it lands before the option button's own click, so the pane
    // is active by the time the choice is applied — and it fires for a tap anywhere on the
    // card, including the empty strip between controls.
    <div
      onPointerDown={armPane}
      className="my-2 p-3 rounded-brand-lg shadow-sm text-[13px] select-none border border-warning/30 bg-warning/[0.06]"
    >
      {/* Same header grammar as AiPermissionCard/AiBlockedCard: icon, what this card is,
          and the tool's own badge. Without it the card opened on a bare sentence and read
          as another paragraph of the transcript rather than something waiting on a tap. */}
      <div className="flex items-center gap-2 mb-2 text-warning font-medium">
        <HelpCircle size={16} className="text-warning shrink-0" />
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
        disabled={inFlight}
        onFocus={() => setTyping(true)}
        onChange={(e) => handleOther(current.question, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (e.nativeEvent?.isComposing || e.keyCode === 229) return; // IME commit
          e.preventDefault();
          handleNext();
        }}
        placeholder="Type your answer..."
        className={`w-full px-1.5 py-1 rounded bg-bg border border-border-subtle text-[12px] text-text placeholder-text-muted/70 focus:outline-none focus:border-brand-500 disabled:opacity-40 ${
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
          disabled={inFlight}
          className="px-2 py-1 rounded text-[12px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          disabled={inFlight || !canAdvance}
          className="px-2.5 py-1 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 text-[12px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span>{isLast ? (inFlight ? "Sending…" : "Submit") : "Next"}</span>
          {isLast ? <CornerDownLeft size={11} /> : <ChevronRight size={12} />}
        </button>
      </div>
    </div>
  );
});
