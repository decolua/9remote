// Navigating while the host is mid-restart lands the webview on a dead origin, and a
// WKWebView left there stays black until the app is relaunched. The update gate holds
// :2208 but answers /api/health with 503 — only the real host passes this.

const HEALTH_POLL_MS = 1500;
// A host that never comes back must not leave a reload button spinning forever.
const HEALTH_WAIT_MS = 90_000;

/** True once the real host answers — the update gate deliberately never does. */
export async function hostReady(timeoutMs = HEALTH_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) return true;
    } catch {}
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
}

/** Reload only into a live host; false when it never came back and the page stays usable. */
export async function reloadWhenHostReady() {
  if (!(await hostReady())) return false;
  window.location.reload();
  return true;
}
