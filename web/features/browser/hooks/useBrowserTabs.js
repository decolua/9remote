"use client";

import { useEffect } from "react";
import { useBrowserStore } from "@/shared/stores/browserStore";

// Host Chrome tabs → the store the terminal-header strip renders. Watching is
// per (profile, window) — the workspace's own Chrome window — and ref-counted
// host-side: the last watcher of a key off = its polling stops.
export function useBrowserTabs(busRef, enabled, profile = "default", windowId = null, wsId = "default") {
  // Agent tabs (engine-driven, every profile) ride their own global event —
  // no window watch needed, so a workspace without a browser window still
  // sees them in its strip.
  useEffect(() => {
    const bus = busRef?.current;
    if (!enabled || !bus?.on) return;
    const onAgent = (data) => {
      useBrowserStore.getState().setAgentTabs(Array.isArray(data?.agentTabs) ? data.agentTabs : []);
    };
    bus.on("browser:agentTabs", onAgent);
    return () => { bus.off?.("browser:agentTabs", onAgent); };
  }, [busRef, enabled]);

  useEffect(() => {
    const bus = busRef?.current;
    // No window yet = this workspace owns no browser tabs: watch nothing (the
    // null-window push is unfiltered host-side and would leak every window).
    if (!enabled || windowId == null || !bus?.on) return;
    const known = new Set();
    let primed = false;
    const onTabs = (data) => {
      // Pushes are keyed by profile+window — ignore every other window's tabs.
      if (data?.profile && data.profile !== profile) return;
      const pushedWindow = data?.windowId ?? null;
      if (pushedWindow !== windowId) return;
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
      // Stable strip order: keep the previous positions, append new tabs at
      // the end (a tab opened later sits to the RIGHT, like every browser) —
      // Target.getTargets guarantees no ordering.
      const prev = st.tabsByWorkspace[wsId] || [];
      const byId = new Map(tabs.map((t) => [t.id, t]));
      const ordered = [
        ...prev.filter((t) => byId.has(t.id)).map((t) => byId.get(t.id)),
        ...tabs.filter((t) => !prev.some((p2) => p2.id === t.id))
      ];
      st.setTabs(wsId, ordered);
      const activeId = st.activeByWorkspace[wsId];
      if (popup) {
        st.setActive(wsId, popup.id);
      } else if (tabs.length && !tabs.some((t) => t.id === activeId)) {
        st.setActive(wsId, (tabs.find((t) => t.active) || tabs[0]).id);
      }
    };
    bus.on("browser:tabs", onTabs);
    bus.emit("browser:tabs.watch", { on: true, profile, windowId });
    return () => {
      bus.off?.("browser:tabs", onTabs);
      bus.emit?.("browser:tabs.watch", { on: false, profile, windowId });
    };
  }, [busRef, enabled, profile, windowId, wsId]);
}
