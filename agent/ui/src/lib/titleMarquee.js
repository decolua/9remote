// Document title — synced 100% with web/shared/utils/titleMarquee.js
const BASE = "9Remote";

// Static, compact title; count-first so it stays visible when the tab is shrunk
export function updateTitle(count) {
  document.title = count > 0 ? `(${count}) 🔔 ${BASE}` : BASE;
}
