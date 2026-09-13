import { useRef, useCallback } from "react";
import { SWIPE_TAB } from "@/features/terminal/constants/terminalConfig";

const overflowXOf = (el) =>
  typeof getComputedStyle === "function" ? getComputedStyle(el).overflowX : "";

/**
 * Does this touch start inside a box that pans horizontally on its own?
 *
 * A wide code block, diff or table scrolls sideways; without this the same drag also
 * cleared the swipe threshold and switched tabs, so scrolling a code block flipped the
 * pane. A scroller only counts while it actually overflows — a code block that fits has
 * nothing to pan, and the swipe stays available there.
 *
 * @param {Element} target The touch target.
 * @param {(el: Element) => string} [getOverflowX] Injectable for tests (no DOM needed).
 * @returns {boolean}
 */
export function startsInScrollerX(target, getOverflowX = overflowXOf) {
  for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
    const overflowX = getOverflowX(el);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    if (el.scrollWidth > el.clientWidth) return true;
  }
  return false;
}

// Horizontal swipe to switch tabs (mobile). Left = next, right = prev — no wrap.
// Passive handlers: never preventDefault so vertical scroll/selection stay intact.
// bind() is called at render with live data, keeping the hook itself top-level.
export function useSwipeTab() {
  const startRef = useRef(null);

  const bind = useCallback(({ enabled, sessionIds, activeSessionId, onSwitch }) => ({
    onTouchStart: (e) => {
      if (!enabled || e.touches.length !== 1) return (startRef.current = null);
      // The gesture belongs to the code block's own pan, not to the tab strip.
      if (startsInScrollerX(e.target)) return (startRef.current = null);
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
  }), []);

  return bind;
}
