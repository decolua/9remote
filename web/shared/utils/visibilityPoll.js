"use client";

// setInterval that stands down while the tab is hidden. Polling for something
// nobody is looking at costs a real `git` run on the host and a round-trip over
// the tunnel, so a backgrounded tab stops and catches up on return.
//
// Returning to the tab fetches immediately rather than waiting out the period,
// so the value on screen is fresher than a plain interval would leave it.
// fireOnReturn: run fn() the moment the tab comes back. Right for data that went
// stale while away; wrong for a timed animation, where it would jump a step in
// front of the user — those resume on the next tick instead.
export function pollWhileVisible(fn, periodMs, { fireOnReturn = true } = {}) {
  let timer = null;

  const start = () => {
    if (timer || (typeof document !== "undefined" && document.hidden)) return;
    timer = setInterval(fn, periodMs);
  };

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (document.hidden) { stop(); return; }
    if (fireOnReturn) fn();
    start();
  };

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  start();

  return () => {
    stop();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
}
