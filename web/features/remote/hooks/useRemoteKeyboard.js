"use client";

import { useRef, useEffect, useCallback } from "react";

// Native keyboard + text panel control, and the pan that keeps the point of
// interest visible when the on-screen keyboard shrinks the viewport.
// Extracted verbatim from RemoteDesktop.
export function useRemoteKeyboard({
  streaming, keyboardOn, setKeyboardOn, showTextPanel, setShowTextPanel,
  textInputRef, canvasContainerRef, panForKeyboard, pointerMode, virtualCursor
}) {
  // Mirror keyboardOn into a ref so onBlur handler reads the latest value
  // synchronously (React state update from toggleKeyboard hasn't committed yet
  // when blur fires → without ref, the blur handler re-focuses and keyboard
  // can't be turned off on Android).
  const keyboardOnRef = useRef(keyboardOn);
  useEffect(() => { keyboardOnRef.current = keyboardOn; }, [keyboardOn]);

  // Toggle native keyboard by focus/blur the hidden text input.
  // Must call focus() SYNCHRONOUSLY inside user gesture — iOS/Android block
  // focus-driven keyboard if wrapped in setTimeout/Promise.
  const toggleKeyboard = useCallback(() => {
    const next = !keyboardOn;
    keyboardOnRef.current = next; // sync before blur() so onBlur sees new value
    setKeyboardOn(next);
    if (next) textInputRef.current?.focus();
    else textInputRef.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOn]);

  // Auto-focus hidden sink once when stream is ready and keyboard was left on (persisted).
  // Best-effort: desktop opens the native keyboard; mobile may block focus outside a gesture.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (!streaming || autoFocusedRef.current || !keyboardOnRef.current) return;
    autoFocusedRef.current = true;
    textInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // When closing panel, sync-focus hidden sink to keep native keyboard visible (iOS gesture rule).
  // When opening, let RemoteControls' useEffect focus the panel textarea after slide-in.
  const toggleTextPanel = useCallback(() => {
    const next = !showTextPanel;
    if (!next && keyboardOn) textInputRef.current?.focus();
    setShowTextPanel(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPanel, keyboardOn]);

  // Re-focus to keep the native keyboard visible. Uses the ref (not state) so
  // toggleKeyboard's blur can actually close it.
  const handleTextInputBlur = useCallback(() => {
    if (keyboardOnRef.current && !showTextPanel) setTimeout(() => textInputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPanel]);

  // On-screen keyboard shrinks the viewport from the bottom; at zoom>1 that can
  // hide the spot the user just tapped. A fixed timeout fired too early — the
  // container hadn't reflowed to the shrunk --app-height yet, so panForKeyboard
  // read the stale (tall) height and did nothing (pan only kicked in later on an
  // unrelated re-clamp, e.g. a mouse move). Instead poll clientHeight via rAF until
  // it actually changes, THEN pan — no timing guesswork.
  // Latest focus point (server px) to keep visible when the keyboard opens: the
  // virtual cursor in trackpad mode, else null (panForKeyboard falls back to the
  // last tapped point). Mirrored into a ref because the rAF callback below runs
  // async and would otherwise close over a stale cursor.
  const focusPxRef = useRef(null);
  useEffect(() => {
    focusPxRef.current = pointerMode === "trackpad" ? virtualCursor : null;
  }, [pointerMode, virtualCursor]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevVVH = vv.height;
    let raf = 0;
    const onResize = () => {
      const shrank = vv.height < prevVVH;
      prevVVH = vv.height;
      const container = canvasContainerRef.current;
      if (!container) return;
      const startH = container.clientHeight;
      cancelAnimationFrame(raf);
      let tries = 0;
      const wait = () => {
        // clientHeight changed → reflow done, safe to read. Bail after ~30 frames.
        if (container.clientHeight !== startH || tries++ > 30) {
          panForKeyboard(shrank, focusPxRef.current);
          return;
        }
        raf = requestAnimationFrame(wait);
      };
      raf = requestAnimationFrame(wait);
    };
    vv.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); vv.removeEventListener("resize", onResize); };
  }, [canvasContainerRef, panForKeyboard]);

  return { keyboardOnRef, toggleKeyboard, toggleTextPanel, handleTextInputBlur };
}
