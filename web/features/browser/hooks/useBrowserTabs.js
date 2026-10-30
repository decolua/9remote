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
    if (!enabled || !bus?.on) return;
    // Session adoption: no window remembered locally → ask the HOST which
    // Chrome window this workspace owns (host is the source of truth, like
    // terminal's getSessions). Old hosts answer "unknown action" — no-op.
    if (windowId != null) return;
    bus.emit("browser:invoke", { action: "window.forWorkspace", payload: { profile, workspaceId: wsId } }, (res) => {
      const win = Number.isFinite(Number(res?.windowId)) && Number(res.windowId) > 0 ? Number(res.windowId) : null;
      if (res?.ok && win) useBrowserStore.getState().setWindowFor(wsId, win);
    });
  }, [busRef, enabled, profile, windowId, wsId]);

  useEffect(() => {
    const bus = busRef?.current;
    // No window yet = this workspace owns no browser tabs so far: watch nothing
    // (the null-window push is unfiltered host-side and would leak every window).
    if (!enabled || windowId == null || !bus?.on) return;
    const known = new Set();
    let primed = false;
    const ingest = (tabs) => {
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
      const fresh = tabs.filter((t) => !prev.some((p2) => p2.id === t.id));
      // A host push can beat the "open" invoke home — the real tab replaces its
      // boot placeholder instead of doubling it in the strip.
      const dropBoots = new Set();
      let boots = Math.min(fresh.length, prev.filter((p) => String(p.id).startsWith("boot_")).length);
      for (const p of prev) {
        if (boots > 0 && String(p.id).startsWith("boot_")) {
          dropBoots.add(p.id);
          boots -= 1;
        }
      }
      const ordered = [
        ...prev.filter((t) => byId.has(t.id) && !dropBoots.has(t.id)).map((t) => byId.get(t.id)),
        ...fresh
      ];
      st.setTabs(wsId, ordered);
      const activeId = st.activeByWorkspace[wsId];
      if (popup) {
        st.setActive(wsId, popup.id);
      } else if (tabs.length && !tabs.some((t) => t.id === activeId)) {
        st.setActive(wsId, (tabs.find((t) => t.active) || tabs[0]).id);
      }
    };
    const onTabs = (data) => {
      // Pushes are keyed by profile+window — ignore every other window's tabs.
      if (data?.profile && data.profile !== profile) return;
      const pushedWindow = data?.windowId ?? null;
      if (pushedWindow !== windowId) return;
      ingest(Array.isArray(data?.tabs) ? data.tabs : []);
    };
    bus.on("browser:tabs", onTabs);
    bus.emit("browser:tabs.watch", { on: true, profile, workspaceId: wsId, windowId }, (res) => {
      // The host may have healed our stale window id — follow it and take its
      // tabs now instead of waiting out the poll tick.
      if (!res?.ok) return;
      const resolved = Number.isFinite(Number(res.windowId)) && Number(res.windowId) > 0 ? Number(res.windowId) : null;
      const st = useBrowserStore.getState();
      if (resolved && resolved !== windowId) st.setWindowFor(wsId, resolved);
      // Dead hint and the host owns no window for this workspace: the session
      // is gone — clear the strip instead of leaving dead tabs behind.
      if (!resolved) {
        st.setWindowFor(wsId, null);
        st.setTabs(wsId, []);
        st.setActive(wsId, null);
      }
      if (Array.isArray(res.tabs) && res.tabs.length) ingest(res.tabs);
    });
    return () => {
      bus.off?.("browser:tabs", onTabs);
      bus.emit?.("browser:tabs.watch", { on: false, profile, workspaceId: wsId, windowId });
    };
  }, [busRef, enabled, profile, windowId, wsId]);
}
