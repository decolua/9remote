"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "@/shared/components/ui/Icon";

// Centered card modal — the app-wide shape (ConfirmDialog / NewTerminalModal):
// backdrop blur, card-elev, responsive max-w, app-height cap, safe-area padding.
// Anchored popovers (context menus, the annotate card) stay separate on purpose.
export default function BrowserModalShell({ title, icon = null, onClose, children, footer = null, wide = false }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  // Portaled: the pane it opens from sits under transformed siblings, and the overlay
  // tracks --app-height so the soft keyboard (the note box) never covers the card.
  return createPortal(
    <div className="modal-overlay z-50 scrim fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`card-elev ${wide ? "max-w-lg" : "max-w-md"} w-full my-auto overflow-hidden flex flex-col pop-in`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-border-subtle">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text min-w-0">
            {icon}
            <span className="truncate">{title}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-text-muted hover:text-text">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-border-subtle">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
