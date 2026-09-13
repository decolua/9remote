"use client";

import { memo, useEffect, useRef } from "react";
import { X } from "@/shared/components/ui/Icon";

// Shared chrome for every AI modal: backdrop, panel, header with an icon and a
// close button. Modals supply only their body, so the frame stays stable.
//
// The frame also owns the modal keyboard contract: Escape closes and the backdrop
// swallows clicks. Without this the composer textarea keeps focus underneath, so
// Escape stops the running turn and Enter sends a prompt while the modal is open.
export const ModalShell = memo(function ModalShell({
  icon,
  iconClass = "bg-brand-500/15 text-brand-500",
  title,
  subtitle,
  maxWidth = "max-w-lg",
  onClose,
  children,
  footer = null
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    // Focus must land inside the panel: the composer textarea keeps DOM focus while
    // the modal is open, so keys would otherwise reach the pane underneath it.
    if (panelRef.current?.contains(document.activeElement)) return;
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Height tracks --app-height (the visual viewport) rather than the layout viewport:
  // with the soft keyboard up, 100vh still measures the full screen, so the panel hangs
  // past the visible area with its bottom rows unreachable. The panel takes a percentage
  // of that measured height for the same reason.
  return (
    <div
      className="fixed inset-x-0 top-0 h-[var(--app-height,100dvh)] bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 select-none"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`card-elev w-full ${maxWidth} overflow-hidden flex flex-col max-h-[80%] animate-in fade-in zoom-in-95 duration-150 outline-none`}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${iconClass}`}>
              {icon}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text truncate">{title}</h2>
              {subtitle && <p className="text-[11px] text-text-muted truncate">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
});
