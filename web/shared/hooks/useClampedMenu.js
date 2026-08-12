import { useEffect, useState } from "react";

// Position an absolutely-positioned popup at (x, y) but flip it toward the
// side with more room when near an edge, so the click point stays on the
// menu's border instead of the menu sliding and covering more neighbors.
// Returns adjusted { left, top }.
export default function useClampedMenu(ref, x, y, margin = 8) {
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref?.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const left = x + width > vw - margin
      ? Math.max(margin, x - width)
      : x;
    const top = y + height > vh - margin
      ? Math.max(margin, y - height)
      : y;

    setPos({ left, top });
  }, [ref, x, y, margin]);

  return pos;
}
