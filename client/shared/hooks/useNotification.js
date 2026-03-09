"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";

/**
 * Hook to manage push notifications and chat notification events
 * Badge state is stored on server, synced to client via socket
 * On any chatNotification → re-fetch full state from server
 */
export function useNotification(socketRef, connected) {
  const subscriptionRef = useRef(null);
  const [notifications, setNotifications] = useState({});
  const getSelectedSession = useTerminalStore((state) => state.getSelectedSession);
  const getCurrentView = useTerminalStore((state) => state.getCurrentView);

  // Subscribe to push notifications and send subscription to server
  const subscribeToPush = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("🔕 Push not supported:", { sw: "serviceWorker" in navigator, pm: "PushManager" in window });
      return;
    }
    if (!socketRef?.current) {
      console.warn("🔕 No socket");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      console.log("🔔 Notification permission:", permission);
      if (permission !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      if (!registration.pushManager) {
        console.warn("🔕 No pushManager on registration");
        return;
      }

      socketRef.current.emit("getVapidKey", async (vapidKey) => {
        console.log("🔑 VAPID key received:", vapidKey ? vapidKey.slice(0, 20) + "..." : "null");
        if (!vapidKey) return;

        try {
          let subscription = await registration.pushManager.getSubscription();
          if (!subscription) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: vapidKey
            });
          }
          console.log("✅ Push subscribed, sending to server");
          socketRef.current.emit("pushSubscribe", subscription.toJSON());
          subscriptionRef.current = subscription;
        } catch (error) {
          console.error("Push subscribe failed:", error);
        }
      });
    } catch (error) {
      console.error("Push notification setup failed:", error);
    }
  }, [socketRef]);

  // Auto re-send existing push subscription when socket connects (to update socketId)
  useEffect(() => {
    const currentSocket = socketRef?.current;
    if (!currentSocket || !connected) return;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const registration = await navigator.serviceWorker.ready;
        if (!registration.pushManager) return;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) currentSocket.emit("pushSubscribe", subscription.toJSON());
      } catch (e) {
        // ignore
      }
    })();
  }, [socketRef, connected]);

  // Listen for notification events from server
  useEffect(() => {
    const currentSocket = socketRef?.current;
    if (!currentSocket || !connected) return;

    const fetchState = () => currentSocket.emit("getNotificationState");

    // Receive full badge state from server, auto-clear active focused tab
    const handleNotificationState = (state) => {
      // console.log("📋 notificationState received:", state);
      const incoming = state || {};
      // If user is viewing a terminal and app is focused → clear that session's badge
      const currentView = getCurrentView();
      const activeSessionId = getSelectedSession();
      if (!document.hidden && currentView?.type === "terminal" && activeSessionId && incoming[activeSessionId]) {
        currentSocket.emit("clearNotification", activeSessionId);
        const { [activeSessionId]: _, ...rest } = incoming;
        setNotifications(rest);
      } else {
        setNotifications(incoming);
      }
    };

    // On any new notification → re-fetch full state (server is source of truth)
    const handleChatNotification = (n) => {
      fetchState();
    };

    // Another client cleared a badge → re-fetch to stay in sync
    const handleNotificationCleared = () => fetchState();

    // Respond to ack if app is focused (server uses this to decide push)
    const handleAck = (notification, callback) => {
      if (!document.hidden) callback("focused");
    };

    // Notify server when visibility changes (best effort)
    const handleVisibilityChange = () => {
      currentSocket.emit("visibilityChange", document.hidden);
    };

    // Fetch latest notification state after reconnect
    const handleReconnect = () => fetchState();

    currentSocket.on("notificationState", handleNotificationState);
    currentSocket.on("chatNotification", handleChatNotification);
    currentSocket.on("chatNotificationAck", handleAck);
    currentSocket.on("notificationCleared", handleNotificationCleared);
    currentSocket.on("connect", handleReconnect);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Request badge state after listeners are registered
    fetchState();

    return () => {
      currentSocket.off("notificationState", handleNotificationState);
      currentSocket.off("chatNotification", handleChatNotification);
      currentSocket.off("chatNotificationAck", handleAck);
      currentSocket.off("notificationCleared", handleNotificationCleared);
      currentSocket.off("connect", handleReconnect);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [socketRef, connected]);

  const clearNotification = useCallback((sessionId) => {
    if (!sessionId) return;
    setNotifications((prev) => {
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    socketRef.current?.emit("clearNotification", sessionId);
  }, [socketRef]);

  const unsubscribeFromPush = useCallback(async () => {
    try {
      if (subscriptionRef.current) {
        await subscriptionRef.current.unsubscribe();
        socketRef.current?.emit("pushUnsubscribe", subscriptionRef.current.endpoint);
        subscriptionRef.current = null;
      } else {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          socketRef.current?.emit("pushUnsubscribe", sub.endpoint);
          await sub.unsubscribe();
        }
      }
    } catch (error) {
      console.error("Push unsubscribe failed:", error);
    }
  }, [socketRef]);

  return { subscribeToPush, unsubscribeFromPush, notifications, clearNotification };
}
