"use client";

import { memo, useEffect, useRef, useState } from "react";

export const BEAM_SPEED_PX_S = 250;
export const BEAM_WIDTH_PX = 140;

// The terminal pane's light sweep, extracted so any status strip can run the same
// gradient at the same constant speed — width is measured, duration derived from it.
export const TerminalBeam = memo(function TerminalBeam({ height = 1, className = "" }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect?.width || el.offsetWidth;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = width || 600;
  const duration = Math.max(1.8, (w + BEAM_WIDTH_PX) / BEAM_SPEED_PX_S);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`absolute inset-x-0 top-0 overflow-hidden pointer-events-none ${className}`}
      style={{
        height,
        "--pane-w": `${w}px`,
        "--beam-w": `${BEAM_WIDTH_PX}px`,
        "--beam-dur": `${duration.toFixed(2)}s`,
        "--beam-delay": `${(duration / 2).toFixed(2)}s`
      }}
    >
      <div className="relative w-full h-full bg-blue-500/10">
        <div className="pane-light-beam" />
        <div className="pane-light-beam pane-light-beam-2" />
      </div>
    </div>
  );
});

export default TerminalBeam;
