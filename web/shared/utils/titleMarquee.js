// Document title — synced 100% with agent/ui/src/lib/titleMarquee.js
const BASE = "9Remote";
const SCROLL = "9Remote \u2022 "; // marquee body, rotates char-by-char
const STEP_MS = 400;

let timer = null;
let offset = 0;
let current = 0;

function render() {
  const rotated = SCROLL.slice(offset) + SCROLL.slice(0, offset);
  document.title = `(${current}) \uD83D\uDD14 ${rotated}`;
  offset = (offset + 1) % SCROLL.length;
}

// count>0: fixed `(n) 🔔 ` prefix + rotating SCROLL body; else static BASE
export function updateTitle(count) {
  current = count;
  if (count > 0) {
    if (!timer) { offset = 0; render(); timer = setInterval(render, STEP_MS); }
  } else {
    if (timer) { clearInterval(timer); timer = null; }
    offset = 0;
    document.title = BASE;
  }
}
