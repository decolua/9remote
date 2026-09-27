"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { CornerDownLeft } from "@/shared/components/ui/Icon";

export default function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmText, cancelText }) {
  const { t } = useI18n();
  const cancelBtnRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const finalConfirm = confirmText ?? t("common.confirm");
  const finalCancel = cancelText ?? t("common.cancel");

  // Steal focus from whatever element had it (e.g. xterm's hidden textarea)
  useEffect(() => {
    if (!isOpen) return;
    const timer = requestAnimationFrame(() => {
      confirmBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, [isOpen]);

  // Keyboard navigation: Enter to confirm, Escape to cancel.
  // Use capture: true so xterm or other child handlers cannot swallow the keystrokes.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Enter") {
        if (cancelBtnRef.current && document.activeElement === cancelBtnRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        vibrate();
        onConfirm?.();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, onClose, onConfirm]);

  if (!isOpen || typeof document === "undefined") return null;

  // Portaled to the body: rendered inside a view whose ancestor creates a
  // stacking context (transform, z-index), a fixed z-50 dialog sinks under
  // sibling layers no matter its own z-index.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
        onClick={onClose}
      />
      
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative card-elev max-w-md w-full my-auto max-h-[min(85%,calc(var(--app-height,85vh)-2rem))] overflow-y-auto animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4">
          <h3 className="text-lg font-semibold text-text">{title}</h3>
        </div>
        
        {/* Body */}
        <div className="px-6 pb-4">
          {/* pre-line: some callers pass a list (a rewind names the files it will
              overwrite). A one-line message renders exactly as before. */}
          <p className="text-text whitespace-pre-line">{message}</p>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 flex justify-end gap-3">
          <button
            ref={cancelBtnRef}
            onClick={() => { vibrate(); onClose(); }}
            className="px-4 py-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.98] font-medium flex items-center gap-1.5"
          >
            <span>{finalCancel}</span>
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => {
              vibrate();
              onConfirm?.();
              onClose();
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-brand transition-all duration-150 ease-out active:scale-[0.98] font-medium flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-red-500/50"
          >
            <span>{finalConfirm}</span>
            <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
              <CornerDownLeft size={10} strokeWidth={2.5} />
            </kbd>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
