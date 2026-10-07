"use client";

import { useEffect } from "react";
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

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center px-4 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-150"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`card-elev ${wide ? "max-w-lg" : "max-w-md"} w-full my-auto max-h-[min(85%,calc(var(--app-height,85vh)-2rem))] overflow-hidden flex flex-col animate-in zoom-in-95 duration-150`}
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
    </div>
  );
}
