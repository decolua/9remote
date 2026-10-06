"use client";

import { useCallback } from "react";

const INVOKE_TIMEOUT_MS = 12000;

export function useBrowserInvoke(busRef) {
  return useCallback((action, payload = {}) => {
    return new Promise((resolve) => {
      const bus = busRef?.current;
      if (!bus?.emit) return resolve({ ok: false, error: "Not connected" });
      let settled = false;
      // An old host ignores browser:* events — without this the UI's loading
      // state hangs forever instead of surfacing an error.
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: false, error: "No reply from host — restart the host?" }); }
      }, INVOKE_TIMEOUT_MS);
      bus.emit("browser:invoke", { action, payload }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res || { ok: false, error: "No reply from host" });
      });
    });
  }, [busRef]);
}
