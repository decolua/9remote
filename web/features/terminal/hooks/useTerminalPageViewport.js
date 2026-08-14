"use client";

import { useEffect } from "react";

// Terminal-page DOM viewport plumbing: --app-height follows visualViewport (soft-KB),
// keyboard-open detection, the iOS 26 offsetTop workaround, body scroll locking, and
// iOS focus auto-scroll suppression. Verbatim moves from the workspace layout.
export function useTerminalPageViewport({ setKeyboardOpen }) {
  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    let lastKeyboardState = false;

    const updateAppHeight = () => {
      const vv = window.visualViewport;
      const vvHeight = vv?.height || window.innerHeight;
      const offsetTop = vv?.offsetTop || 0;
      const isKeyboardOpen = vvHeight < window.innerHeight - 100;

      if (lastKeyboardState !== isKeyboardOpen) {
        lastKeyboardState = isKeyboardOpen;
        setKeyboardOpen(isKeyboardOpen);
      }

      // Always follow visualViewport height so the terminal fits the exact visible area
      document.documentElement.style.setProperty("--app-height", `${vvHeight}px`);

      // iOS 26 Safari bug (FB20191055): offsetTop stays > 0 after keyboard dismiss
      if (!isKeyboardOpen && offsetTop > 0) {
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

    return () => {
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
      if (
        e.target.closest(".xterm-viewport") ||
        e.target.closest(".xterm-screen") ||
        e.target.closest(".terminal-scroll") ||
        e.target.closest(".cm-scroller") ||
        e.target.closest(".cm-content") ||
        e.target.closest(".overflow-auto") ||
        e.target.closest(".overflow-x-auto") ||
        e.target.closest(".overflow-y-auto") ||
        e.target.closest(".modal-scrollable")
      ) return;
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
}
