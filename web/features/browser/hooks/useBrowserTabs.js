"use client";

import { useEffect } from "react";
import { useBrowserStore } from "@/shared/stores/browserStore";

// Subscribe to the host's browser tab push. tabs.peek first so the strip fills
// before the host's first poll tick; watch off on unmount — the host stops
// polling (and stops streaming) when the last watcher leaves.
export function useBrowserTabs(busRef, enabled) {
  useEffect(() => {
    const bus = busRef?.current;
    if (!enabled || !bus?.emit) return;
    bus.emit("browser:tabs.watch", { on: true });
    bus.emit("browser:invoke", { action: "tabs" }, (res) => {
      if (res?.ok) useBrowserStore.getState().setTabs(res.tabs);
    });
    const onTabs = (payload) => useBrowserStore.getState().setTabs(payload?.tabs);
    bus.on?.("browser:tabs", onTabs);
    return () => {
      bus.emit("browser:tabs.watch", { on: false });
      bus.off?.("browser:tabs", onTabs);
    };
  }, [busRef, enabled]);
}
