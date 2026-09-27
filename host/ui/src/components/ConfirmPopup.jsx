import { useRef, useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";

export default function ConfirmPopup({ message, confirmLabel = "Confirm", confirmDanger = false, inputValue, onInput, inputPlaceholder = "", onConfirm, onCancel }) {
  const hasInput = onInput !== undefined;
  const inputRef = useRef(null);
  const cancelBtnRef = useRef(null);
  const confirmBtnRef = useRef(null);

  useEffect(() => {
    if (hasInput) inputRef.current?.focus();
    else confirmBtnRef.current?.focus();

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
      } else if (e.key === "Enter" && !hasInput) {
        if (cancelBtnRef.current && document.activeElement === cancelBtnRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        onConfirm?.();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [hasInput, onConfirm, onCancel]);

  const content = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[4px] animate-in fade-in duration-150" onClick={onCancel}>
      <div className="glass-card p-5 flex flex-col gap-4 w-72 animate-in zoom-in-95 duration-150" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm text-center" style={{ color: "var(--text-main)" }}>{message}</p>
        {hasInput && (
          <input
            ref={inputRef}
            value={inputValue}
            placeholder={inputPlaceholder}
            onInput={(e) => onInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConfirm()}
            className="w-full px-3 py-2 text-sm rounded-xl"
            style={{ background: "var(--glass-bg)", color: "var(--text-main)", border: "1px solid var(--border)" }}
          />
        )}
        <div className="flex gap-2">
          <button ref={cancelBtnRef} onClick={onCancel} className="glass-btn flex-1 py-2 text-sm flex items-center justify-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <span>Cancel</span>
            <kbd className="text-[10px] font-mono px-1 py-0.5 rounded opacity-70 leading-none" style={{ background: "var(--glass-bg)" }}>Esc</kbd>
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            className="flex-1 py-2 text-sm font-semibold rounded-xl flex items-center justify-center gap-1.5"
            style={{ background: confirmDanger ? "rgba(220,53,69,0.8)" : "var(--brand-500)", color: "#fff" }}
          >
            <span>{confirmLabel}</span>
            <kbd className="text-[10px] font-mono px-1 py-0.5 rounded bg-white/20 text-white leading-none">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(content, document.body);
  }
  return content;
}
