import { useState } from "react";

const DEVICE_ID_KEY = "9remote_deviceId";

/**
 * Generate + persist a unique deviceId in localStorage.
 * Survives page reloads; new browser/incognito = new deviceId.
 */
export function useDeviceId() {
  const [deviceId] = useState(() => {
    if (typeof window === "undefined") return null;
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      // Fallback for non-secure contexts (e.g. http over LAN IP) where crypto.randomUUID is unavailable
      id =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  });
  return deviceId;
}
