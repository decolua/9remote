// AI agent status → visual (dot color + css class + pulse + i18n label).
// Single source of truth for UI rendering. Add a state → add one entry here + CSS.
"use client";

export const STATUS_STYLE = {
  idle:    { dot: "#22c55e", cls: "st-idle",    label: "common.statusIdle" },
  working: { dot: "#3b82f6", cls: "st-working", pulse: "soft",  label: "common.statusWorking" },
  blocked: { dot: "#ef4444", cls: "st-blocked", pulse: "strong", label: "common.statusBlocked" },
  done:    { dot: "#f59e0b", cls: "st-done",    label: "common.statusDone" },
};

export const statusVisual = (state) => STATUS_STYLE[state] || STATUS_STYLE.idle;

// Dot className for a given state — used by tab/card dots everywhere.
export const dotClassName = (state) => {
  const v = statusVisual(state);
  return `term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`;
};
