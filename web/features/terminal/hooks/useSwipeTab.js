import { useRef } from "react";
import { SWIPE_TAB } from "@/features/terminal/constants/terminalConfig";

// Horizontal swipe to switch tabs (mobile). Left = next, right = prev — no wrap.
// Passive handlers: never preventDefault so vertical scroll/selection stay intact.
// bind() is called at render with live data, keeping the hook itself top-level.
export function useSwipeTab() {
  const startRef = useRef(null);

  const bind = ({ enabled, sessionIds, activeSessionId, onSwitch }) => ({
    onTouchStart: (e) => {
      if (!enabled || e.touches.length !== 1) return (startRef.current = null);
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, time: performance.now() };
    },
    onTouchEnd: (e) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start || !enabled || sessionIds.length < 2) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const elapsed = performance.now() - start.time;
      // Horizontal intent only: fast, mostly-horizontal, long-enough swipe
      if (
        elapsed > SWIPE_TAB.maxDuration ||
        Math.abs(dx) < SWIPE_TAB.minDistance ||
        Math.abs(dx) < Math.abs(dy) * SWIPE_TAB.ratio
      ) return;
      const idx = sessionIds.indexOf(activeSessionId);
      if (idx === -1) return;
      const next = dx < 0 ? sessionIds[idx + 1] : sessionIds[idx - 1];
      if (next && next !== activeSessionId) onSwitch?.(next);
    }
  });

  return bind;
}
