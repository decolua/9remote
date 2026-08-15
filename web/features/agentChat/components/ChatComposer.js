"use client";

import { useCallback, useRef, useState } from "react";
import { ArrowUp, Square } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

// Typing here writes into the same PTY the terminal view shows — this is not a second
// conversation, it is a keyboard.
export default function ChatComposer({ onSend, onInterrupt, busy, disabled }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  const submit = useCallback(async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    const res = await onSend(value);
    setSending(false);
    if (res?.success) {
      setText("");
      textareaRef.current?.focus();
    }
  }, [text, sending, disabled, onSend]);

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter is a newline, matching every chat input the user knows.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const showStop = busy && !text.trim();

  return (
    <div
      className="shrink-0 px-3 pb-3 pt-2 sm:px-4"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <div className="relative mx-auto w-full" style={{ maxWidth: "54.25rem" }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? t("terminalPane.agentChatComposerBlocked") : t("terminalPane.agentChatComposerPlaceholder")}
          className="w-full resize-none rounded-[10px] border border-border-subtle bg-surface-2 py-3 pl-3.5 pr-14 font-mono text-sm text-text placeholder-text-subtle transition-all duration-150 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-50"
          style={{ fieldSizing: "content", maxHeight: "calc(8lh + 0.5rem)" }}
        />

        <button
          type="button"
          onClick={() => {
            vibrate();
            if (showStop) onInterrupt?.();
            else submit();
          }}
          disabled={disabled || (!showStop && !text.trim())}
          aria-label={showStop ? t("terminalPane.agentChatStop") : t("terminalPane.agentChatSend")}
          className={`absolute bottom-2.5 right-2.5 grid h-9 w-9 place-items-center rounded-full transition-all duration-150 active:scale-[0.94] disabled:opacity-30 ${
            showStop ? "bg-surface-3 text-text" : "bg-brand-500 text-white shadow-lg shadow-brand-500/30"
          }`}
        >
          {showStop ? <Square size={14} className="fill-current" /> : <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  );
}
