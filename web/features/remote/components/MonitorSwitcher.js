"use client";

// Monitor selector overlay — bottom-right of the canvas container.
// Renders nothing when there is only one monitor (common case).
export default function MonitorSwitcher({ list, activeIndex, onSelect }) {
  if (!Array.isArray(list) || list.length <= 1) return null;
  return (
    <div className="absolute bottom-3 right-3 z-40 flex gap-1.5">
      {list.map((m) => {
        const active = m.index === activeIndex;
        const label = m.name && m.name.length <= 8 ? m.name : `#${m.index + 1}`;
        return (
          <button
            key={m.index}
            onClick={() => onSelect?.(m.index)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium backdrop-blur-md border transition-colors ${
              active
                ? "bg-blue-500/90 text-white border-blue-400"
                : "bg-black/50 text-white/80 border-white/10 hover:bg-black/70"
            }`}
            title={`${m.name} (${m.width}×${m.height})`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
