"use client";

import { useCallback } from "react";
import { useBrowserStore } from "@/shared/stores/browserStore";

const INVOKE_TIMEOUT_MS = 12000;

export function useBrowserInvoke(busRef) {
  return useCallback((action, payload = {}) => {
    return new Promise((resolve) => {
      const bus = busRef?.current;
      if (!bus?.emit) return resolve({ ok: false, error: "Not connected" });
      const activeProf = useBrowserStore.getState().activeProfile || "default";
      const fullPayload = { profile: activeProf, ...payload };
      let settled = false;
      // An old host ignores browser:* events — without this the UI's loading
      // state hangs forever instead of surfacing an error.
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: false, error: "No reply from host — restart the host?" }); }
      }, INVOKE_TIMEOUT_MS);
      bus.emit("browser:invoke", { action, payload: fullPayload }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res || { ok: false, error: "No reply from host" });
      });
    });
  }, [busRef]);
}
