"use client";

import { useEffect, useCallback, useMemo, useRef } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useFleetStore, fleetBusOf } from "@/shared/stores/fleetStore";
import { useAllSessionStatus } from "@/shared/transport/hostConn";
import { attentionSummary } from "@/features/terminal/lib/sessionStatusSummary";

/**
 * Hook to manage push notifications and chat notification events
 * Badge state is stored on server, synced to client via bus
 * Live updates arrive as statusChange (one entry); full maps are refetched only on
 * reconnect and when another client clears a badge.
 * NOTE: badge state shape here is `notifications` (object keyed by sessionId);
 * the agent preact UI uses a Set `finishedIds` (see agent/ui/src/lib/terminalSocket.js) — equivalent semantics.
 */
// Persisted across reloads; survives SW updates so toggle-off sticks
export const USER_DISABLED_KEY = "9remote:push:userDisabled";

export function useNotification(busRef, connected) {
  const subscriptionRef = useRef(null);
  const notifications = useNotificationStore((s) => s.notifications);
  const getSelectedSession = useTerminalStore((state) => state.getSelectedSession);
  const getCurrentView = useTerminalStore((state) => state.getCurrentView);
  const pushView = useTerminalStore((state) => state.pushView);
  const addOpenedSession = useTerminalStore((state) => state.addOpenedSession);

  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;

  // Every host this device should hear from: the active bus plus each online
  // fleet bus. Push is per (host, device) server-side — one browser
  // subscription object is simply announced to all of them. The selector
  // returns a PRIMITIVE (joined heads): the map's identity changes on every
  // status tick, and re-announcing per tick would spam every bus.
  const onlineFleetHeads = useFleetStore((s) => Object.values(s.hosts)
    .filter((h) => h.status === "online")
    .map((h) => h.key)
    .join(","));
  const eachOnlineBus = useCallback((fn) => {
    if (busRef?.current) fn(busRef.current);
    for (const h of Object.values(useFleetStore.getState().hosts)) {
      if (h.status !== "online") continue;
      const b = fleetBusOf(h.key);
      if (b) fn(b);
    }
  }, [busRef]);
  const subPayload = (sub) => (sub?.type === "expo" ? { type: "expo", token: sub.token } : sub?.toJSON?.() || sub);

  // Expose deep-link handler for native notification tap (Expo WebView)
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.handleNotificationTap = (payload) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) return;
      addOpenedSession(sessionId);
      pushView({ type: "terminal", sessionId });
    };
    return () => {
      try { delete window.handleNotificationTap; } catch (e) { window.handleNotificationTap = undefined; }
    };
  }, [pushView, addOpenedSession]);

  // Native shell drives focus state: document.hidden never flips inside a WebView
  useEffect(() => {
    if (typeof window === "undefined" || !isExpoWebView) return;
    window.handleAppStateChange = (hidden) => {
      eachOnlineBus((b) => b.emit("visibilityChange", !!hidden));
      // PM recovery listens on DOM — bus.emit only travels over the wire to the host
      document.dispatchEvent(new CustomEvent("app-visibility", { detail: { hidden: !!hidden } }));
    };
    return () => {
      try { delete window.handleAppStateChange; } catch (e) { window.handleAppStateChange = undefined; }
    };
  }, [busRef, isExpoWebView, eachOnlineBus]);

  // Subscribe to push notifications and send subscription to server
  const subscribeToPush = useCallback(async () => {
    if (!busRef?.current) return;
    if (typeof window !== "undefined") localStorage.removeItem(USER_DISABLED_KEY);

    // Expo WebView: request token via native bridge
    if (isExpoWebView) {
      window.handleExpoPushToken = (token) => {
        eachOnlineBus((b) => b.emit("pushSubscribe", { type: "expo", token }));
        subscriptionRef.current = { type: "expo", token };
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "REQUEST_PUSH_TOKEN" }));
      return;
    }

    // PWA: WebPush via Service Worker
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("🔕 Push not supported");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      if (!registration.pushManager) return;

      // Await the bus callback so caller can rely on subscription being ready
      const vapidKey = await new Promise((resolve) => busRef.current.emit("getVapidKey", resolve));
      if (!vapidKey) return;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey
        });
      }
      eachOnlineBus((b) => {
        b.emit("pushSubscribe", subscription.toJSON());
        // Sync current visibility so server knows focus state immediately
        b.emit("visibilityChange", document.hidden);
      });
      subscriptionRef.current = subscription;
    } catch (error) {
      console.error("Push notification setup failed:", error);
    }
  }, [busRef, isExpoWebView]);

  // Auto re-send existing subscription on reconnect
  useEffect(() => {
    const currentSocket = busRef?.current;
    if (!currentSocket || !connected) return;
    // Honor explicit user toggle-off (survives SW updates and reloads)
    if (typeof window !== "undefined" && localStorage.getItem(USER_DISABLED_KEY) === "1") return;

    if (isExpoWebView) {
      // Re-request token via bridge to update socketId on server
      window.handleExpoPushToken = (token) => {
        currentSocket.emit("pushSubscribe", { type: "expo", token });
        subscriptionRef.current = { type: "expo", token };
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "REQUEST_PUSH_TOKEN" }));
      return;
    }

    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const registration = await navigator.serviceWorker.ready;
        if (!registration.pushManager) return;
        let subscription = await registration.pushManager.getSubscription();
        // iOS silently drops the sub on SW update/expiry. Re-subscribe if permission
        // is still granted so the toggle doesn't turn itself off between deploys.
        if (!subscription && Notification.permission === "granted") {
          const vapidKey = await new Promise((resolve) => currentSocket.emit("getVapidKey", resolve));
          if (vapidKey) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: vapidKey
            });
          }
        }
        if (subscription) {
          currentSocket.emit("pushSubscribe", subscription.toJSON());
          // Re-sync focus state — addPushSubscription keeps stale hidden flag otherwise
          currentSocket.emit("visibilityChange", document.hidden);
        }
      } catch (e) { /* ignore */ }
    })();
  }, [busRef, connected, isExpoWebView]);

  // A fleet bus that comes online mid-session must hear the subscription too —
  // the host side is idempotent (addPushSubscription overwrites), and hosts
  // never went through the subscribe flow themselves.
  useEffect(() => {
    if (!subscriptionRef.current) return;
    if (typeof window !== "undefined" && localStorage.getItem(USER_DISABLED_KEY) === "1") return;
    eachOnlineBus((b) => b.emit("pushSubscribe", subPayload(subscriptionRef.current)));
  }, [onlineFleetHeads, eachOnlineBus]);

  // Listen for notification events from server
  useEffect(() => {
    const currentSocket = busRef?.current;
    if (!currentSocket || !connected) return;

    const fetchState = () => {
      currentSocket.emit("getStatusState");
      currentSocket.emit("getNotificationState");
    };

    // Status events land in the main host's fleet entry — the single status lane
    // (fleet buses bind the same store actions in fleetStore._openHost).
    // Preserve last-known tool for sessions the agent cleared (no longer in map)
    // so the agent icon persists when idle.
    const mainHead = () => useFleetStore.getState().currentKey;
    const handleStatusState = (state) => useFleetStore.getState().applyStatusState(mainHead(), state);
    const handleStatusChange = (payload) => {
      useNotificationStore.getState().handleStatusChange(payload);
      useFleetStore.getState().applyStatusChange(mainHead(), payload);
      if (payload && (payload.state === "done" || payload.state === "blocked")) {
        const isDone = payload.state === "done";
        const label = payload.tool ? payload.tool.charAt(0).toUpperCase() + payload.tool.slice(1) : "Terminal";
        const title = isDone ? `${label} · your turn` : `${label} needs input`;
        const body = isDone ? "The agent finished its turn and is waiting for you" : "Action required to proceed";
        if (typeof window !== "undefined" && window.__9R_DESKTOP__?.showNotification) {
          window.__9R_DESKTOP__.showNotification(title, body);
        }
      }
    };
    const handleStatusCleared = (sessionId) => useFleetStore.getState().applyStatusCleared(mainHead(), sessionId);
    const handleNotificationState = (state) => useNotificationStore.getState().handleNotificationState(state);

    // Another client cleared a badge → re-fetch to stay in sync
    const handleNotificationCleared = () => fetchState();

    // Notify server when visibility changes → server gates push on this (no ack round-trip)
    const handleVisibilityChange = () => {
      currentSocket.emit("visibilityChange", document.hidden);
    };

    // Fetch latest notification state after reconnect
    const handleReconnect = () => fetchState();

    currentSocket.on("notificationState", handleNotificationState);
    currentSocket.on("notificationCleared", handleNotificationCleared);
    currentSocket.on("statusState", handleStatusState);
    currentSocket.on("statusChange", handleStatusChange);
    currentSocket.on("statusCleared", handleStatusCleared);
    currentSocket.on("connect", handleReconnect);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Request badge state after listeners are registered
    fetchState();

    return () => {
      currentSocket.off("notificationState", handleNotificationState);
      currentSocket.off("notificationCleared", handleNotificationCleared);
      currentSocket.off("statusState", handleStatusState);
      currentSocket.off("statusChange", handleStatusChange);
      currentSocket.off("statusCleared", handleStatusCleared);
      currentSocket.off("connect", handleReconnect);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [busRef, connected]);

  // Sync in-app attention count → PWA icon badge + desktop Dock badge.
  // Counted off the flat status map (the same reading the bell and the mobile
  // badge use) rather than the notifications map, so every surface shows one
  // number — and every host's attention counts, main and fleet alike.
  const sessionStatus = useAllSessionStatus();
  const count = useMemo(() => attentionSummary(sessionStatus).total, [sessionStatus]);
  useEffect(() => {
    if (typeof window !== "undefined" && window.__9R_DESKTOP__?.setBadge) {
      window.__9R_DESKTOP__.setBadge(count);
    }
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
    if (count > 0) {
      navigator.setAppBadge(count).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }, [count]);

  const unsubscribeFromPush = useCallback(async () => {
    if (typeof window !== "undefined") localStorage.setItem(USER_DISABLED_KEY, "1");
    try {
      if (subscriptionRef.current?.type === "expo") {
        eachOnlineBus((b) => b.emit("pushUnsubscribe", subscriptionRef.current.token));
        subscriptionRef.current = null;
        return;
      }
      if (subscriptionRef.current) {
        await subscriptionRef.current.unsubscribe();
        eachOnlineBus((b) => b.emit("pushUnsubscribe", subscriptionRef.current.endpoint));
        subscriptionRef.current = null;
      } else {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          eachOnlineBus((b) => b.emit("pushUnsubscribe", sub.endpoint));
          await sub.unsubscribe();
        }
      }
    } catch (error) {
      console.error("Push unsubscribe failed:", error);
    }
  }, [busRef, eachOnlineBus]);

  return { subscribeToPush, unsubscribeFromPush, notifications };
}
