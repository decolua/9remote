"use client";

import { STATUS_BAR_HEIGHT } from "@/shared/constants/layout";

// The one status bar. Every workspace surface renders this same shell and fills the two
// slots — before this there were two lookalike bars at different heights, so switching
// between terminal and file explorer made the whole page shift by 2px.
// `display` is left to the caller so a bar can be desktop-only ("hidden sm:flex") — a
// hard-coded `flex` here would win against that class by file order, not specificity.
export default function StatusBar({ left, right, className = "flex" }) {
  return (
    <div
      style={{ height: STATUS_BAR_HEIGHT }}
      className={`items-center gap-3 px-3 flex-shrink-0 bg-surface border-t border-border-subtle text-[11px] text-text-muted select-none ${className}`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">{left}</div>
      <div className="flex items-center gap-3 flex-shrink-0">{right}</div>
    </div>
  );
}

// Shared look for a clickable segment, so the terminal and explorer bars stay identical.
export const statusItemCls =
  "flex items-center gap-1.5 px-1.5 py-0.5 rounded-[2px] hover:bg-white/10 transition-colors cursor-pointer";

export const statusTextCls = "flex items-center gap-1.5 px-1.5 py-0.5";
