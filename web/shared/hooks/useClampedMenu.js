import { useEffect, useState } from "react";

// Position an absolutely-positioned popup at (x, y) but flip it toward the
// side with more room when near an edge, so the click point stays on the
// menu's border instead of the menu sliding and covering more neighbors.
// Returns adjusted { left, top }.
export default function useClampedMenu(ref, x, y, margin = 8) {
  // Compute best initial position immediately so frame 0 never flashes at (0, 0)
  const computeInitial = (targetX, targetY) => {
    if (typeof window === "undefined" || (targetX === 0 && targetY === 0)) {
      return { left: targetX, top: targetY };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const estWidth = 160;
    const estHeight = 120;
    const left = targetX + estWidth > vw - margin ? Math.max(margin, targetX - estWidth) : targetX;
    const top = targetY + estHeight > vh - margin ? Math.max(margin, targetY - estHeight) : targetY;
    return { left, top };
  };

  const [pos, setPos] = useState(() => computeInitial(x, y));
  const [prev, setPrev] = useState({ x, y });

  if (prev.x !== x || prev.y !== y) {
    setPrev({ x, y });
    setPos(computeInitial(x, y));
  }

  useEffect(() => {
    const el = ref?.current;
    if (!el || (x === 0 && y === 0)) return;
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
