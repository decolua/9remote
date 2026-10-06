"use client";

import { useCallback } from "react";

export function useBrowserInvoke(busRef) {
  return useCallback((action, payload = {}) => {
    return new Promise((resolve) => {
      const bus = busRef?.current;
      if (!bus?.emit) return resolve({ ok: false, error: "Not connected" });
      bus.emit("browser:invoke", { action, payload }, (res) => {
        resolve(res || { ok: false, error: "No reply from host" });
      });
    });
  }, [busRef]);
}
