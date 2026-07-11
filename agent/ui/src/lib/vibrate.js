// Lightweight vibration wrapper — agent UI runs in a desktop browser; standard API only.
export function vibrate(duration = 10) {
  try { if (navigator.vibrate) navigator.vibrate(duration); } catch {}
}
