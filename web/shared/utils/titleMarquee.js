// Document title — synced 100% with agent/ui/src/lib/titleMarquee.js
const BASE = "9Remote";
const SCROLL = "9Remote • "; // marquee body, rotates char-by-char
const STEP_MS = 400;

let timer = null;
let offset = 0;
let current = 0;
let desired = null; // title we want; re-applied if something overwrites it
let observer = null;

// Next re-applies the static route metadata title after each navigation — watch
// <title> and restore ours so a tab switch does not fall back to the default.
function guard() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(() => {
    if (desired && document.title !== desired) setTitle(desired);
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
}

function unguard() {
  if (!observer) return;
  observer.disconnect();
  observer = null;
}

// Writing the title mutates <head>, which is exactly what the observer watches —
// so it must not be listening while we write, or it re-triggers itself forever.
function setTitle(value) {
  desired = value;
  const watching = observer;
  if (watching) watching.disconnect();
  document.title = value;
  if (watching) watching.observe(document.head, { childList: true, subtree: true, characterData: true });
}

function render() {
  const rotated = SCROLL.slice(offset) + SCROLL.slice(0, offset);
  setTitle(`(${current}) 🔔 ${rotated}`);
  offset = (offset + 1) % SCROLL.length;
}

// count>0: fixed `(n) 🔔 ` prefix + rotating SCROLL body; else show active name or BASE
export function updateTitle(count, activeName) {
  current = count;
  if (count > 0) {
    guard();
    if (!timer) { offset = 0; render(); timer = setInterval(render, STEP_MS); }
  } else {
    if (timer) { clearInterval(timer); timer = null; }
    offset = 0;
    if (activeName) { guard(); setTitle(`${activeName} • ${BASE}`); }
    else { unguard(); desired = null; document.title = BASE; }
  }
}
