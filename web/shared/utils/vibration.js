/**
 * Vibration utility with iOS Safari fallback
 * Uses hidden switch input trick for WebKit browsers that don't support Vibration API
 */

export function vibrate(duration = 10) {
  // Android Expo shell: navigator.vibrate exists in Android WebView but is a no-op
  // there, so the native bridge must win. UA gate — DEVICE_INFO is injected post-load
  // and can be missing. iOS keeps its WebView haptic path below.
  if (window.ReactNativeWebView && /Android/i.test(navigator.userAgent)) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "HAPTIC", style: "selection" }));
    } catch {}
    return;
  }

  // Standard Vibration API (Android browsers)
  if (navigator.vibrate) {
    navigator.vibrate(duration);
    return;
  }

  // iOS Safari fallback: toggle hidden switch input for haptic feedback
  if (typeof document !== "undefined") {
    const isIOS = typeof navigator !== "undefined" && (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      window.DEVICE_INFO?.platform === "ios" || // expo shell replaces the whole UA
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
    if (!isIOS) return;

    const el = document.createElement("div");
    const id = Math.random().toString(36).slice(2);
    el.innerHTML = `<input type="checkbox" id="${id}" switch /><label for="${id}"></label>`;
    el.setAttribute("style", "display:none !important;opacity:0 !important;visibility:hidden !important;");
    document.body.appendChild(el);
    el.querySelector("label").click();
    setTimeout(() => el.remove(), 100);
  }
}
