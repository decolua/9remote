"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import PromptCardShell from "./PromptCardShell";

const MAX_NUMBER_KEY = 9;

/**
 * Steps through the model's questions and turns the choices into option numbers.
 *
 * The answer travels to the CLI as keystrokes, so only what a number key can express is
 * offered: single-select, one option per question. Multi-select is shown read-only with a
 * pointer to the terminal rather than guessed at.
 */
export default function QuestionCard({ prompt, onRespond, busy }) {
  const { t } = useI18n();
  const questions = useMemo(() => prompt?.toolInput?.questions || [], [prompt]);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState({});
  // Free text is only reachable on the last question — the selector auto-advances on a
  // pick, and typing mid-set has not been verified against a real screen.
  const [typedText, setTypedText] = useState("");
  const [typingRaw, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const containerRef = useRef(null);
  const typedInputRef = useRef(null);

  const question = questions[step];
  const total = questions.length;
  const isLast = step === total - 1;

  // Only a question whose options cannot be reached by a number key is truly unanswerable
  // here. A multi-select question still accepts a single pick — treating it as unsupported
  // locked out every set that merely CONTAINED one, including its single-select questions.
  const tooManyOptions = (question?.options?.length || 0) > MAX_NUMBER_KEY;
  const unsupported = tooManyOptions;
  // Shown as a note, not a lock: picking one of several is fine, picking several is not.
  const multiSelect = !!question?.multiSelect;

  // Typing is only offered on the last question, so leaving it simply stops applying —
  // no state reset needed, and a half-typed answer cannot follow the user to another step.
  const typing = typingRaw && isLast;
  const typedReady = typing && typedText.trim().length > 0 && !/[\r\n]/.test(typedText);
  // The last question may be answered by typing instead of picking.
  const lastAnswered = typing ? typedReady : picked[total - 1] != null;
  const answeredAll = total > 0
    && questions.slice(0, -1).every((_, i) => picked[i] != null)
    && lastAnswered;

  useEffect(() => {
    if (typing) typedInputRef.current?.focus();
    else containerRef.current?.focus();
  }, [step, typing]);

  const choose = useCallback((index) => {
    setTyping(false);
    setPicked((prev) => ({ ...prev, [step]: index }));
  }, [step]);

  const submit = useCallback(async () => {
    if (!answeredAll) return;
    setSending(true);
    const answers = questions.map((_, i) =>
      (typing && i === total - 1) ? { text: typedText.trim() } : { optionIndex: picked[i] }
    );
    await onRespond({ answers });
    setSending(false);
  }, [answeredAll, onRespond, questions, picked, typing, typedText, total]);

  const skip = useCallback(async () => {
    setSending(true);
    await onRespond({ action: "skip" });
    setSending(false);
  }, [onRespond]);

  const advance = useCallback(() => {
    if (isLast) submit();
    else setStep((s) => s + 1);
  }, [isLast, submit]);

  const onKeyDown = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (unsupported) return;
    const n = parseInt(e.key, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= (question?.options?.length || 0)) {
      e.preventDefault();
      choose(n);
      return;
    }
    if (e.key === "0" && isLast) {
      e.preventDefault();
      setTyping(true);
      setPicked((p) => ({ ...p, [step]: null }));
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); advance(); return; }
    if (e.key === "Escape") { e.preventDefault(); skip(); }
  };

  if (!question) return null;
  const disabled = busy || sending;

  return (
    <div ref={containerRef} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
      <PromptCardShell
        eyebrow={t("terminalPane.agentChatQuestionEyebrow")}
        icon={<Icon name="MessageCircleQuestion" size={15} />}
        footer={
          <>
            <button
              type="button"
              onClick={skip}
              disabled={disabled}
              className="text-[11px] text-text-subtle transition-colors hover:text-text disabled:opacity-40"
            >
              {total > 1 ? t("terminalPane.agentChatSkipAll") : t("terminalPane.agentChatSkip")}
              <span className="ml-1 font-mono text-[9px] opacity-70">Esc</span>
            </button>
            <div className="flex items-center gap-1.5">
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => setStep((s) => s - 1)}
                  disabled={disabled}
                  className="rounded-[8px] px-2.5 py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
                >
                  {t("terminalPane.agentChatBack")}
                </button>
              )}
              <button
                type="button"
                onClick={advance}
                disabled={disabled || unsupported || (isLast ? !answeredAll : picked[step] == null)}
                className="btn-cta rounded-[8px] bg-brand-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-lg shadow-brand-500/30 transition-all duration-150 active:scale-[0.97] disabled:animate-none disabled:opacity-30 disabled:shadow-none"
              >
                {isLast ? t("terminalPane.agentChatSubmit") : t("terminalPane.agentChatNext")}
                <span className="ml-1 font-mono text-[9px] opacity-70">Enter</span>
              </button>
            </div>
          </>
        }
      >
        {total > 1 && (
          <div className="mb-2 mt-1.5 flex items-center gap-1">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`${i + 1}/${total}`}
                onClick={() => setStep(i)}
                className={`h-[3px] rounded-full transition-all duration-300 ${
                  i === step ? "w-5 bg-brand-500" : picked[i] != null ? "w-2.5 bg-brand-500/40" : "w-2.5 bg-surface-3"
                }`}
              />
            ))}
            <span className="ml-auto font-mono text-[10px] tabular-nums text-text-subtle">{step + 1}/{total}</span>
          </div>
        )}

        <p className="mt-0.5 text-[14px] font-medium leading-snug text-text">{question.question}</p>

        {unsupported && (
          <p className="mt-1.5 rounded-[8px] bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-muted">
            {t("terminalPane.agentChatAnswerInTerminal")}
          </p>
        )}
        {!unsupported && multiSelect && (
          <p className="mt-1 text-[10px] text-text-subtle">
            {t("terminalPane.agentChatPickOneOnly")}
          </p>
        )}

        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-0.5" role="radiogroup" aria-label={question.question}>
          {(question.options || []).map((opt, idx) => {
            const number = idx + 1;
            const selected = picked[step] === number;
            return (
              <button
                key={opt.label ?? idx}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose(number)}
                disabled={disabled || unsupported}
                className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? "border-brand-500 bg-brand-500/10 ring-2 ring-brand-500/20"
                    : "border-border-subtle hover:border-border hover:bg-surface-2"
                }`}
              >
                <kbd
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-[7px] font-mono text-[10px] transition-colors ${
                    selected ? "bg-brand-500 font-semibold text-white" : "border border-border-subtle bg-surface-2 text-text-subtle"
                  }`}
                >
                  {number <= MAX_NUMBER_KEY ? number : "·"}
                </kbd>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] leading-tight ${selected ? "font-medium text-text" : "text-text-muted"}`}>
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-text-subtle">{opt.description}</span>
                  )}
                </span>
                {selected && <Icon name="Check" size={15} className="shrink-0 text-brand-500" />}
              </button>
            );
          })}

          {/* The selector's own "Type something." row, mirrored here. Only on the last
              question: mid-set the TUI moves on the moment an option is picked. */}
          {isLast && !unsupported && (
            <button
              type="button"
              onClick={() => { setTyping(true); setPicked((p) => ({ ...p, [step]: null })); }}
              disabled={disabled}
              className={`flex w-full items-center gap-2.5 rounded-[10px] border border-dashed px-3 py-2 text-left transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                typing ? "border-brand-500 bg-brand-500/10 ring-2 ring-brand-500/20" : "border-border-subtle hover:border-border hover:bg-surface-2"
              }`}
            >
              <kbd className={`grid h-5 w-5 shrink-0 place-items-center rounded-[7px] font-mono text-[10px] ${
                typing ? "bg-brand-500 font-semibold text-white" : "border border-border-subtle bg-surface-2 text-text-subtle"
              }`}>
                0
              </kbd>
              <span className={`text-[13px] leading-tight ${typing ? "font-medium text-text" : "text-text-muted"}`}>
                {t("terminalPane.agentChatTypeSomething")}
              </span>
            </button>
          )}

          {typing && (
            <div className="pl-[30px]">
              <input
                ref={typedInputRef}
                type="text"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") { e.preventDefault(); submit(); }
                  if (e.key === "Escape") { e.preventDefault(); setTyping(false); }
                }}
                disabled={disabled}
                placeholder={t("terminalPane.agentChatTypePlaceholder")}
                className="w-full rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-1.5 text-[13px] text-text placeholder-text-subtle transition-all duration-150 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          )}
        </div>
      </PromptCardShell>
    </div>
  );
}
