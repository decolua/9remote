"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { OVERFLOW_TIP } from "@/features/terminal/constants/terminalConfig";

// One delegated tooltip for the whole view: any element carrying `data-tip` gets it,
// and only when its text is really clipped — a tip on a label that already fits is noise.
// Rendered in a portal so a sidebar's own overflow can't clip it.

// scrollWidth/clientWidth are rounded to integers, so a one-character overflow reads as
// "fits". A Range around the content measures the text's own width with fractional
// accuracy — and unlike toggling overflow, it stays right when a flex or max-width
// parent, not the content, is what decides the element's width.
function isClipped(el) {
  const box = el.getBoundingClientRect();
  if (el.scrollHeight > el.clientHeight + OVERFLOW_TIP.SLACK_PX) return true;
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect().width;
  range.detach();
  const style = getComputedStyle(el);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  return text > box.width - padding + OVERFLOW_TIP.SLACK_PX;
}

// Place below the anchor, flipping above when the viewport bottom is closer than the tip
// is tall, and clamping horizontally so it never hangs off an edge.
function placement(rect) {
  const { GAP_PX, EDGE_PX, MAX_WIDTH_PX, EST_HEIGHT_PX } = OVERFLOW_TIP;
  const below = rect.bottom + GAP_PX;
  const flip = below + EST_HEIGHT_PX > window.innerHeight - EDGE_PX;
  const left = Math.min(
    Math.max(rect.left, EDGE_PX),
    Math.max(EDGE_PX, window.innerWidth - MAX_WIDTH_PX - EDGE_PX)
  );
  return { left, top: flip ? undefined : below, bottom: flip ? window.innerHeight - rect.top + GAP_PX : undefined };
}

export default function OverflowTip() {
  const [tip, setTip] = useState(null);
  const isTouch = useInputMode() !== "mouse";

  useEffect(() => {
    if (isTouch) return;
    let timer = null;
    let anchor = null;

    const hide = () => {
      clearTimeout(timer);
      anchor = null;
      setTip(null);
    };

    const show = (el) => {
      const text = el.getAttribute("data-tip");
      if (!text || !isClipped(el)) return;
      setTip({ text, ...placement(el.getBoundingClientRect()) });
    };

    const arm = (e) => {
      const el = e.target?.closest?.("[data-tip]");
      if (el === anchor) return;
      clearTimeout(timer);
      anchor = el;
      if (!el) return setTip(null);
      // Focus is a deliberate landing, hover is not — keyboard users shouldn't wait.
      timer = setTimeout(() => show(el), e.type === "focusin" ? 0 : OVERFLOW_TIP.DELAY_MS);
    };

    const onKey = (e) => { if (e.key === "Escape") hide(); };

    document.addEventListener("mouseover", arm, true);
    document.addEventListener("focusin", arm, true);
    document.addEventListener("focusout", hide, true);
    // Pointer leaving the page never produces a mouseover elsewhere, so hide explicitly.
    document.documentElement.addEventListener("mouseleave", hide);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", onKey, true);
    // The tip is placed once, so anything that moves the anchor dismisses it.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseover", arm, true);
      document.removeEventListener("focusin", arm, true);
      document.removeEventListener("focusout", hide, true);
      document.documentElement.removeEventListener("mouseleave", hide);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [isTouch]);

  if (!tip) return null;

  return createPortal(
    <div
      role="tooltip"
      className="fixed z-[90] pointer-events-none px-2 py-1 rounded-[3px] bg-surface-2 border border-border-subtle shadow-lg text-[11px] text-text break-words animate-in fade-in duration-100"
      style={{ left: tip.left, top: tip.top, bottom: tip.bottom, maxWidth: OVERFLOW_TIP.MAX_WIDTH_PX }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
