"use client";

// Text with a highlight sweeping across it — the "still thinking" cue.
// The gradient is painted through the glyphs via background-clip, so it inherits
// whatever text size and weight the caller uses.
export default function Shimmer({ children, className = "" }) {
  return <span className={`shimmer-text ${className}`}>{children}</span>;
}
