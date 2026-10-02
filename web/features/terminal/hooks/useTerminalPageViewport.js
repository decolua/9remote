"use client";

import { useEffect } from "react";

// Terminal-page DOM viewport plumbing: --app-height follows visualViewport (soft-KB),
// keyboard-open detection, the iOS 26 offsetTop workaround, body scroll locking, and
// iOS focus auto-scroll suppression. Verbatim moves from the workspace layout.

// Containers that own their own scrolling — a touchmove inside one is not a body scroll.
const SCROLLABLE_SELECTOR = [
  ".xterm-viewport", ".xterm-screen", ".terminal-scroll",
  ".cm-scroller", ".cm-content",
  ".overflow-auto", ".overflow-x-auto", ".overflow-y-auto",
  ".modal-scrollable", ".brand-range"
].join(",");

export function useTerminalPageViewport({ setKeyboardOpen }) {
  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    let lastKeyboardState = false;
    // iOS-only: on Android (interactive-widget=resizes-content) innerHeight shrinks
    // with the keyboard, so the isKeyboardOpen check misfires and the translateY
    // below would push the whole layout up by the keyboard height.
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    // Android (interactive-widget=resizes-content) shrinks innerHeight together with
    // visualViewport, so the vv-vs-innerHeight check never fires there. Track the
    // tallest height seen per width instead — the keyboard never changes width.
    const maxHeights = {};
    const updateAppHeight = () => {
      const vv = window.visualViewport;
      const vvHeight = vv?.height || window.innerHeight;
      const offsetTop = vv?.offsetTop || 0;
      const width = window.innerWidth;
      if (maxHeights[width] === undefined || vvHeight > maxHeights[width]) {
        maxHeights[width] = vvHeight;
      }
      const isKeyboardOpen = vvHeight < window.innerHeight - 100 ||
        vvHeight < maxHeights[width] - 100;

      if (lastKeyboardState !== isKeyboardOpen) {
        lastKeyboardState = isKeyboardOpen;
        setKeyboardOpen(isKeyboardOpen);
      }

      // Always follow visualViewport height so the terminal fits the exact visible area
      document.documentElement.style.setProperty("--app-height", `${vvHeight}px`);

      // iOS 26 Safari bug (FB20191055): offsetTop stays > 0 after keyboard dismiss
      if (isIos && !isKeyboardOpen && offsetTop > 0) {
        document.documentElement.style.transform = `translateY(${-offsetTop}px)`;
      } else {
        document.documentElement.style.transform = "";
      }
      window.scrollTo(0, 0);
    };

    document.documentElement.classList.add("terminal-page");

    let timerId = 0;
    const onResize = () => {
      clearTimeout(timerId);
      timerId = setTimeout(updateAppHeight, 100);
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize);
      window.visualViewport.addEventListener("scroll", onResize);
    }
    window.addEventListener("resize", onResize);
    onResize();

    // Android expo WebView does not deliver viewport resize events when the native
    // view resizes (soft keyboard) — poll the live height instead of waiting.
    const isExpoAndroid = window.ReactNativeWebView && /Android/i.test(navigator.userAgent);
    const pollTimer = isExpoAndroid ? setInterval(onResize, 250) : 0;

    return () => {
      clearInterval(pollTimer);
      clearTimeout(timerId);
      document.documentElement.classList.remove("terminal-page");
      document.documentElement.style.transform = "";
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResize);
        window.visualViewport.removeEventListener("scroll", onResize);
      }
      window.removeEventListener("resize", onResize);
    };
  }, [setKeyboardOpen]);

  // Prevent body scroll on touchmove (allow scroll in specific containers)
  useEffect(() => {
    const preventScroll = (e) => {
      // One selector, one DOM walk — this fires on every touchmove frame
      if (e.target.closest(SCROLLABLE_SELECTOR)) return;
      e.preventDefault();
    };
    document.addEventListener("touchmove", preventScroll, { passive: false });
    return () => document.removeEventListener("touchmove", preventScroll);
  }, []);

  // Prevent iOS auto-scroll pushing the fixed layout when focusing inputs
  useEffect(() => {
    const handleFocusIn = (e) => {
      if (e.target.matches("input, textarea")) {
        requestAnimationFrame(() => window.scrollTo(0, 0));
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  // Relay editable focus to the expo shell so it can shrink the WebView BEFORE the
  // soft keyboard opens. Android WebView's reveal-scroll only fires for an obscured
  // focused editable — pre-shrinking keeps it visible and the reveal never runs.
  useEffect(() => {
    if (!window.ReactNativeWebView || !/Android/i.test(navigator.userAgent)) return;
    const relay = (e) => {
      if (!e.target.matches("input, textarea")) return;
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "INPUT_FOCUS", focused: e.type === "focusin" }));
      } catch (err) {}
    };
    document.addEventListener("focusin", relay);
    document.addEventListener("focusout", relay);
    return () => {
      document.removeEventListener("focusin", relay);
      document.removeEventListener("focusout", relay);
    };
  }, []);
}
