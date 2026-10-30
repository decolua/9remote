"use client";

import { useRef, useState, useEffect, useMemo } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { BROWSER_INPUT } from "@/features/browser/constants/BROWSER_INPUT";

// Pure emitter factory: all mutable state lives in `st`, config is read through `ctx()`.
export function createEmitters(ctx, st) {
  const flush = () => {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    const { busRef, targetId, profile, onClipboard } = ctx();
    if (!st.queue.length || !targetId) { st.queue.length = 0; return; }
    const events = st.queue.splice(0);
    busRef?.current?.emit?.("browser:input", { targetId, events, profile }, (res) => {
      if (res?.clipboard) onClipboard?.(res.clipboard);
    });
  };
  // Moves and wheel deltas merge into the trailing event; everything else flushes now.
  const push = (evt, { lazy = false } = {}) => {
    const last = st.queue[st.queue.length - 1];
    if (lazy && last && last.t === evt.t && last.type === evt.type && !!last.drag === !!evt.drag) {
      if (evt.t === "wheel") {
        evt.deltaX += last.deltaX;
        evt.deltaY += last.deltaY;
      }
      st.queue[st.queue.length - 1] = evt;
    } else {
      st.queue.push(evt);
    }
    if (!lazy) return flush();
    if (!st.timer) st.timer = setTimeout(flush, BROWSER_INPUT.flushMs);
  };

  // percent of the canvas → page CSS px (the canvas shares the page's aspect ratio)
  const toPage = (percentX, percentY) => {
    const { frameRef, getCanvas } = ctx();
    const meta = frameRef?.current?.meta;
    const canvas = getCanvas?.();
    const w = meta?.deviceWidth || canvas?.width || 0;
    const h = meta?.deviceHeight || canvas?.height || 0;
    return { x: Math.round((percentX / 100) * w), y: Math.round((percentY / 100) * h) };
  };

  const emitMouseMove = (percentX, percentY) => {
    st.pos = toPage(percentX, percentY);
    push({ t: "pointer", type: "move", ...st.pos, ...(st.held ? { drag: true, button: st.held } : {}) }, { lazy: true });
  };
  const emitMousePress = (percentX, percentY, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) return; // context menu owns right-click
    const p = (st.pos = toPage(percentX, percentY));
    const now = Date.now();
    const lp = st.lastPress;
    const near = Math.abs(p.x - lp.x) < REMOTE_CONFIG.moveThreshold && Math.abs(p.y - lp.y) < REMOTE_CONFIG.moveThreshold;
    st.clickCount = near && now - lp.at < REMOTE_CONFIG.doubleClickDelay
      ? Math.min(lp.count + 1, BROWSER_INPUT.maxClickCount)
      : 1;
    st.lastPress = { at: now, x: p.x, y: p.y, count: st.clickCount };
    st.held = button;
    push({ t: "pointer", type: "press", ...p, button, clickCount: st.clickCount });
  };
  const emitMouseRelease = (percentX, percentY, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) return;
    const p = (st.pos = toPage(percentX, percentY));
    st.held = null;
    push({ t: "pointer", type: "release", ...p, button, clickCount: st.clickCount });
  };
  const emitMouseClick = (percentX, percentY, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) {
      const p = toPage(percentX, percentY);
      ctx().onSecondaryClick?.(p.x, p.y);
      return;
    }
    emitMousePress(percentX, percentY, button);
    emitMouseRelease(percentX, percentY, button);
  };

  return {
    emitMouseMove,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseDragSelect: (sx, sy, ex, ey) => {
      emitMousePress(sx, sy);
      emitMouseMove(ex, ey);
      emitMouseRelease(ex, ey);
    },
    emitKeyPress: (key, modifiers = []) => push({ t: "key", key, modifiers }),
    emitTypeText: (text) => push({ t: "text", text }),
    // Raw touch forwarding (natural mobile): points are page CSS px; moves
    // coalesce on the trailing edge like mouse moves do.
    emitTouch: (type, points) => push({ t: "touch", type, points: Array.isArray(points) ? points.slice(0, 5) : [] }, { lazy: type === "move" }),
    emitScroll: (direction, amount = 20, horizontal = false) => {
      const px = amount * BROWSER_INPUT.wheelScale;
      const sign = direction === "down" || direction === "right" ? 1 : -1;
      const along = horizontal || direction === "left" || direction === "right";
      push({ t: "wheel", ...st.pos, deltaX: along ? sign * px : 0, deltaY: along ? 0 : sign * px }, { lazy: true });
    },
    // Chrome screencasts damage only; no adaptive boost / focus rect on this stream.
    emitBoostStream: () => {},
    emitRequestScreenWithHashes: (tileHashes) => {
      const { busRef, targetId } = ctx();
      if (targetId) busRef?.current?.emit?.("browser:request-tiles-hashes", { targetId, tileHashes });
    }
  };
}

// useRemoteBus-shaped adapter over `browser:input`: Remote Desktop's canvas/input hooks
// speak "percent of screen" + robotjs key names; this turns that into page-pixel CDP
// events, so the whole remote input stack is reused unchanged.
// getCanvas(): the shared canvas element. onSecondaryClick(pageX, pageY): right-click
// becomes the pane's context menu. onClipboard(text): what a copy/cut chord selected.
export function useBrowserBus({ busRef, connected, targetId, profile, frameRef, getCanvas, onSecondaryClick, onClipboard }) {
  const streaming = !!connected && !!targetId;
  const ctxRef = useRef({});
  useEffect(() => {
    ctxRef.current = { busRef, targetId, profile, frameRef, getCanvas, onSecondaryClick, onClipboard };
  });

  // Lazy init: emitters are built once; every read goes through ctxRef at call time.
  const [emits] = useState(() => createEmitters(() => ctxRef.current, {
    queue: [], timer: null, held: null, pos: { x: 0, y: 0 }, clickCount: 1,
    lastPress: { at: 0, x: 0, y: 0, count: 0 }
  }));

  // Gate every emitter on streaming like useRemoteBus does.
  return useMemo(() => {
    const gated = { streaming };
    for (const [name, fn] of Object.entries(emits)) gated[name] = (...a) => { if (streaming) fn(...a); };
    return gated;
  }, [emits, streaming]);
}
