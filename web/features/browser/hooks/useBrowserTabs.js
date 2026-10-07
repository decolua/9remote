"use client";

import { useEffect } from "react";
import { useBrowserStore } from "@/shared/stores/browserStore";

// Host Chrome tabs → the store the terminal-header strip renders. Watching is
// ref-counted host-side, so pane closed = polling stops.
export function useBrowserTabs(busRef, enabled) {
  const activeProfile = useBrowserStore((s) => s.activeProfile);
  useEffect(() => {
    const bus = busRef?.current;
    if (!enabled || !bus?.on) return;
    const known = new Set();
    let primed = false;
    const onTabs = (data) => {
      const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
      const st = useBrowserStore.getState();
      // A popup (window.open → openerId set) the page just opened takes over
      // the pane — OAuth flows are unusable any other way on a streamed tab.
      // Mobile only: desktop floats the popup over the parent stream instead
      // (BrowserPopupWindow) and must not steal the active tab.
      // Skip the very first push: every tab is "new" there.
      const mobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;
      const popup = primed && mobile ? tabs.find((t) => t.openerId && !known.has(t.id)) : null;
      primed = true;
      for (const t of tabs) known.add(t.id);
      st.setTabs(tabs);
      if (popup) {
        st.setActive(popup.id);
      } else if (tabs.length && !tabs.some((t) => t.id === st.activeTargetId)) {
        st.setActive((tabs.find((t) => t.active) || tabs[0]).id);
      }
    };
    bus.on("browser:tabs", onTabs);
    bus.emit("browser:tabs.watch", { on: true, profile: activeProfile || "default" });
    return () => {
      bus.off?.("browser:tabs", onTabs);
      bus.emit?.("browser:tabs.watch", { on: false });
    };
  }, [busRef, enabled, activeProfile]);
}
