"use client";

import { useState, useEffect, useCallback } from "react";
import { vibrate } from "@/shared/utils/vibration";
import { USER_DISABLED_KEY } from "@/shared/hooks/useNotification";

// Push on/off state shared by the mobile menu and the desktop settings dialog.
// Source of truth = actual push subscription, not Notification.permission (can't be revoked via JS).
export function usePushToggle(subscribeToPush, unsubscribeFromPush) {
  // Treat native WebView (Expo) the same as PWA for UI gating
  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;
  const supported = isExpoWebView ||
    (typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window);

  // Expo has no PushManager — the user toggle flag is the only local state there
  const [enabled, setEnabled] = useState(() =>
    typeof window !== "undefined" && !!window.ReactNativeWebView &&
    localStorage.getItem(USER_DISABLED_KEY) !== "1"
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || isExpoWebView) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager?.getSubscription())
      .then((sub) => setEnabled(!!sub))
      .catch(() => {});
  }, [isExpoWebView]);

  const toggle = useCallback(async () => {
    if (loading) return;
    vibrate();
    setLoading(true);
    if (enabled) {
      await unsubscribeFromPush?.();
      setEnabled(false);
    } else {
      await subscribeToPush?.();
      // Confirm via real subscription (Expo has no PushManager)
      let next = isExpoWebView;
      if (!isExpoWebView && "serviceWorker" in navigator && "PushManager" in window) {
        try {
          const reg = await navigator.serviceWorker.ready;
          next = !!(await reg.pushManager?.getSubscription());
        } catch { next = false; }
      }
      setEnabled(next);
    }
    setLoading(false);
  }, [enabled, loading, subscribeToPush, unsubscribeFromPush, isExpoWebView]);

  return { supported, enabled, loading, toggle, isExpoWebView };
}
