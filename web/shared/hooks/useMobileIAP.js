import { useEffect, useState, useCallback } from "react";

// Client bridge to the native paywall (StoreKit/Play Billing) inside the app shell.
// Native owns products, purchase and restore; web only opens the sheet and reads
// entitlement. Browser (no window.MOBILE_APP) → isNative=false, use the web flow.

const isAvailable = () =>
  typeof window !== "undefined" && window.MOBILE_APP && window.ReactNativeWebView;

const INACTIVE = { plan: null, status: "inactive", expiresAt: null };

export default function useMobileIAP() {
  const [entitlement, setEntitlement] = useState(INACTIVE);

  useEffect(() => {
    if (!isAvailable()) return;
    const handler = (event) => {
      const payload = event.detail || event;
      if (payload?.kind === "entitlement" && payload.entitlement) {
        setEntitlement(payload.entitlement);
      }
    };
    window.addEventListener("handleIAPEvent", handler);
    if (!window.handleIAPEvent) {
      window.handleIAPEvent = (payload) =>
        window.dispatchEvent(new CustomEvent("handleIAPEvent", { detail: payload }));
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "IAP_GET_ENTITLEMENT" }));
    return () => window.removeEventListener("handleIAPEvent", handler);
  }, []);

  const openPaywall = useCallback(() => {
    if (!isAvailable()) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "SHOW_PAYWALL" }));
  }, []);

  return {
    isNative: isAvailable(),
    entitlement,
    isPro: entitlement.status === "active",
    openPaywall
  };
}
