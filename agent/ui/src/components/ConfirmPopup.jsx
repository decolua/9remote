import { useRef, useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";

export default function ConfirmPopup({ message, confirmLabel = "Confirm", confirmDanger = false, inputValue, onInput, inputPlaceholder = "", onConfirm, onCancel }) {
  const hasInput = onInput !== undefined;
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

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
          <button onClick={onCancel} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 text-sm font-semibold rounded-xl"
            style={{ background: confirmDanger ? "rgba(220,53,69,0.8)" : "var(--brand-500)", color: "#fff" }}
          >
            {confirmLabel}
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
