"use client";

// Chip in the login vocabulary: pill, mono, tiny. A settled successful call shows
// nothing — a badge on every finished row is noise, not information.
const STYLES = {
  running: "bg-brand-500/12 text-brand-500",
  error: "bg-danger/12 text-danger",
  denied: "bg-surface-3 text-text-muted",
};

export default function ToolStatusBadge({ status, label }) {
  const style = STYLES[status];
  if (!style) return null;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${style}`}>
      {label || status}
    </span>
  );
}
