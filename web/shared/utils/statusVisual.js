// AI agent status → visual (dot color + css class + pulse + glow + i18n label).
// Single source of truth for UI rendering. Add a state → add one entry here + CSS.
"use client";

export const STATUS_STYLE = {
  idle:    { dot: "#22c55e", cls: "st-idle",    label: "common.statusIdle" },
  working: { dot: "#3b82f6", cls: "st-working", pulse: "soft",  glow: "rgba(59,130,246,0.30)", label: "common.statusWorking" },
  blocked: { dot: "#ef4444", cls: "st-blocked", pulse: "strong", glow: "rgba(239,68,68,0.32)", label: "common.statusBlocked" },
  done:    { dot: "#f59e0b", cls: "st-done",    glow: "rgba(245,158,11,0.22)", label: "common.statusDone" },
  // Idle-killed CLI process — resting; a prompt respawns it resuming the chat.
  sleep:   { dot: "#94a3b8", cls: "st-sleep",   label: "common.statusSleep" },
};

export const statusVisual = (state) => STATUS_STYLE[state] || STATUS_STYLE.idle;

// Dot className for a given state — used by tab/card dots everywhere.
export const dotClassName = (state) => {
  const v = statusVisual(state);
  return `term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`;
};

// Attention order for a collapsed container's aggregate dot: a blocked child
// outranks a working one, which outranks a finished one.
export const STATUS_PRIORITY = ["blocked", "working", "done"];

// One dot per PRESENT state for a group of children, attention order first.
// Empty when every child is idle/sleeping.
export const statusCounts = (states = []) =>
  STATUS_PRIORITY
    .map((state) => {
      const count = states.filter((s) => s === state).length;
      return count ? { state, count } : null;
    })
    .filter(Boolean);
