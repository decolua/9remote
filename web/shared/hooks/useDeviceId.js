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
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  });
  return deviceId;
}
