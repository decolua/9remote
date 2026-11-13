"use client";

/**
 * Height transition for inline panels that used to pop in and out. Content stays
 * mounted, so a form inside keeps its state across a close/reopen; while closed it is
 * inert and untabbable. Ported from 9love's Collapse, including its duration.
 */
const DEFAULT_MS = 240;

export default function Collapse({ open = false, children, className = "", durationMs = DEFAULT_MS }) {
  return (
    <div
      className={`collapse ${open ? "collapse-open" : ""} ${className}`}
      style={{ transitionDuration: `${durationMs}ms` }}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
