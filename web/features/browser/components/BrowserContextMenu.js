"use client";

import { useEffect, useRef } from "react";
import useClampedMenu from "@/shared/hooks/useClampedMenu";

// Right-click / long-press menu over the streamed page (orca remote pane shape).
export default function BrowserContextMenu({ menu, items, onClose }) {
  const ref = useRef(null);
  const pos = useClampedMenu(ref, menu?.x ?? 0, menu?.y ?? 0);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="fixed z-[80] menu-popover p-1 min-w-[170px] animate-in fade-in zoom-in-95 duration-100 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={`d${i}`} className="my-1 h-px bg-border-subtle" />
        ) : (
          <button
            key={item.label}
            type="button"
            onClick={() => { item.onPick?.(); onClose(); }}
            className="w-full text-left px-2 py-1.5 text-xs text-text hover:bg-surface-2/80 rounded-[6px] flex items-center gap-2"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        )
      )}
    </div>
  );
}
