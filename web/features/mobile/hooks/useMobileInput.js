"use client";

// Pointer + keyboard → scrcpy input events. Coordinates leave as unit floats so
// the client never tracks device resolution; the agent scales them.

import { useCallback, useRef } from "react";
import { WHEEL_LINE_PX, WHEEL_PAGE_PX, WHEEL_NOTCH_PX, SCROLL_MAX } from "../constants/mobileConfig";

// Browser key → Android keycode, for the keys a soft keyboard can't send as text.
const KEY_MAP = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Delete: 112,
  Home: 122,
  End: 123
};

export function useMobileInput({ socketRef, canvasRef }) {
  const pressRef = useRef(null);
  // Moves coalesce to one per animation frame: a touch can fire 120+ moves/sec,
  // and through a tunnel they arrive bunched, which Android's velocity tracker
  // reads as a violent fling.
  const latestMoveRef = useRef(null);
  const moveRafRef = useRef(0);

  const send = useCallback((msg) => {
    socketRef?.current?.emit("mobile:input", msg);
  }, [socketRef]);

  const flushMove = useCallback(() => {
    moveRafRef.current = 0;
    const move = latestMoveRef.current;
    if (!move) return;
    latestMoveRef.current = null;
    send({ type: "touch", action: "move", ...move });
  }, [send]);

  // Canvas is letterboxed by CSS object-fit, so map through the painted rect,
  // not the element box, or every tap lands offset.
  const toUnit = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const paintedW = canvas.width * scale;
    const paintedH = canvas.height * scale;
    const originX = rect.left + (rect.width - paintedW) / 2;
    const originY = rect.top + (rect.height - paintedH) / 2;
    const x = (event.clientX - originX) / paintedW;
    const y = (event.clientY - originY) / paintedH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, [canvasRef]);

  const onPointerDown = useCallback((event) => {
    const pos = toUnit(event);
    if (!pos) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pressRef.current = pos;
    send({ type: "touch", action: "down", ...pos });
  }, [send, toUnit]);

  const onPointerMove = useCallback((event) => {
    if (!pressRef.current) return;
    const pos = toUnit(event);
    if (!pos) return;
    latestMoveRef.current = pos;
    if (!moveRafRef.current) moveRafRef.current = requestAnimationFrame(flushMove);
  }, [flushMove, toUnit]);

  // A wheel is a scroll, not a drag: scrcpy has a scroll message that Android
  // treats as one, so fling physics and nested scrolling behave properly — and
  // it is one packet instead of the ~17 a simulated swipe sends.
  const onWheel = useCallback((event) => {
    const pos = toUnit(event);
    if (!pos) return;
    event.preventDefault();
    // deltaMode 1 is lines, 2 is pages; normalise both to roughly a notch each.
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const notches = (delta) => Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, -(delta * unit) / WHEEL_NOTCH_PX));
    send({ type: "scroll", ...pos, hscroll: notches(event.deltaX), vscroll: notches(event.deltaY) });
  }, [send, toUnit]);

  const endPress = useCallback((event) => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    // Drop any pending move: the up carries the final position, and a stale
    // move landing after it would start a phantom touch.
    latestMoveRef.current = null;
    if (moveRafRef.current) { cancelAnimationFrame(moveRafRef.current); moveRafRef.current = 0; }
    const pos = toUnit(event) || { x: press.x, y: press.y };
    // down/up is already a complete tap to Android — sending a `tap` on top of
    // it registers as a second press (double-tap zoom, duplicated keystrokes).
    send({ type: "touch", action: "up", ...pos });
  }, [send, toUnit]);

  const onKeyDown = useCallback((event) => {
    const mapped = KEY_MAP[event.key];
    if (mapped) {
      event.preventDefault();
      send({ type: "key", keycode: mapped });
      return;
    }
    // Printable characters go as text so IME and non-ASCII work.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  }, [send]);

  const sendKey = useCallback((name) => send({ type: "key", name }), [send]);
  const sendText = useCallback((text) => send({ type: "text", text }), [send]);

  return { onPointerDown, onPointerMove, onPointerUp: endPress, onPointerCancel: endPress, onWheel, onKeyDown, sendKey, sendText };
}
