"use client";

import { vibrate } from "@/shared/utils/vibration";

// Monitor selector overlay — bottom-right of the canvas container.
// Renders nothing when there is only one monitor (common case).
export default function MonitorSwitcher({ list, activeIndex, onSelect }) {
  if (!Array.isArray(list) || list.length <= 1) return null;
  // Stop propagation on BOTH pointer and touch chains: the canvas container
  // listens to onTouchStart (mobile) and the canvas to onPointerDown (PC).
  // Without this, a tap on the button bubbles up → canvas handler fires →
  // emits a mouse event into the remote desktop behind the button.
  const stop = (e) => e.stopPropagation();
  return (
    <div className="absolute bottom-1.5 right-1.5 z-40 flex gap-1.5">
      {list.map((m) => {
        const active = m.index === activeIndex;
        const label = `${m.index + 1}`;
        return (
          <button
            key={m.index}
            onClick={() => { vibrate(); onSelect?.(m.index); }}
            onPointerDown={stop}
            onPointerUp={stop}
            onPointerMove={stop}
            onTouchStart={stop}
            onTouchMove={stop}
            onTouchEnd={stop}
            onWheel={stop}
            className={`px-1.5 py-0.5 rounded-md text-xs font-medium backdrop-blur-md border transition-colors inline-flex items-center gap-1 ${
              active
                ? "bg-blue-500/70 text-white border-blue-400/70"
                : "bg-black/30 text-white/80 border-white/10 hover:bg-black/50"
            }`}
            title={`${m.name} (${m.width}×${m.height})`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            {label}
          </button>
        );
      })}
    </div>
  );
}
