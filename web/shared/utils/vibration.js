/**
 * Vibration utility with iOS Safari fallback
 * Uses hidden switch input trick for WebKit browsers that don't support Vibration API
 */

export function vibrate(duration = 10) {
  // Standard Vibration API
  if (navigator.vibrate) {
    navigator.vibrate(duration);
    return;
  }

  // iOS Safari fallback: toggle hidden switch input for haptic feedback
  if (typeof document !== "undefined") {
    const el = document.createElement("div");
    const id = Math.random().toString(36).slice(2);
    el.innerHTML = `<input type="checkbox" id="${id}" switch /><label for="${id}"></label>`;
    el.setAttribute("style", "display:none !important;opacity:0 !important;visibility:hidden !important;");
    document.body.appendChild(el);
    el.querySelector("label").click();
    setTimeout(() => el.remove(), 100);
  }
}
