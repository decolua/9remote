// Bridge to the Tauri desktop shell. Every call is guarded so the agent UI
// also runs standalone (npm `9remote`) and in a regular browser — when there
// is no Tauri shell, all functions no-op.

const tauriGlobal = typeof window !== "undefined" ? window.__TAURI__ : null;

export const isTauri = () => !!tauriGlobal && typeof tauriGlobal?.core?.invoke === "function";

// macOS dock badge + Windows taskbar overlay. count 0 → clear.
export async function setTauriBadge(count) {
  if (!isTauri()) return;
  try {
    await tauriGlobal.core.invoke("set_badge", { count: count > 0 ? count : 0 });
  } catch {
    // Unsupported on some platforms (e.g. Linux) — silently ignore.
  }
}

// Local OS banner. Sender decides when (e.g. only when document.hidden).
export async function showTauriNotification({ title, body }) {
  if (!isTauri()) return;
  try {
    await tauriGlobal.core.invoke("show_notif", { title, body });
  } catch {
    // Permission denied or unsupported — ignore.
  }
}
