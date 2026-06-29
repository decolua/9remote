// Document title marquee — synced 100% with agent/ui/src/lib/titleMarquee.js
const BASE = "9Remote";
const MARQUEE_MS = 350;
const doneText = (n) => `✨ (${n}) Terminal done — ${BASE} `;

let timer = null;
let idx = 0;

// Drive a scrolling document.title when count>0, static base otherwise
export function updateTitle(count) {
  if (timer) { clearInterval(timer); timer = null; }
  if (count <= 0) { document.title = BASE; return; }
  const text = doneText(count);
  idx = 0;
  const tick = () => { document.title = text.slice(idx) + text.slice(0, idx); idx = (idx + 1) % text.length; };
  tick();
  timer = setInterval(tick, MARQUEE_MS);
}
