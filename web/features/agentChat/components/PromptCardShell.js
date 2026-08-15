"use client";

// Shared frame for the three interactive cards: elevated surface, a brand rule along the
// top edge, and the login page's mono uppercase eyebrow.
export default function PromptCardShell({ eyebrow, icon, live = true, children, footer }) {
  return (
    <div className="card-elev relative overflow-hidden border border-border-subtle">
      <span className="absolute inset-x-0 top-0 h-[2px] bg-brand-500" />

      <div className="flex items-start gap-2.5 px-4 pb-2 pt-3.5">
        {icon && (
          <div className="relative shrink-0">
            <div className="grid h-7 w-7 place-items-center rounded-[9px] bg-brand-500/12 text-brand-500">
              {icon}
            </div>
            {live && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse-glow rounded-full bg-brand-500" />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] uppercase tracking-wider text-text-subtle">{eyebrow}</div>
          {children}
        </div>
      </div>

      {footer && (
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-2/50 px-4 py-2">
          {footer}
        </div>
      )}
    </div>
  );
}
