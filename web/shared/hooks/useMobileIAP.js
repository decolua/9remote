import { useEffect, useState, useCallback, useRef } from "react";
import { getAccountId, getEntitlement } from "@/shared/lib/iapClient";

// Client bridge to native IAP (StoreKit/Play Billing) via WebView.
// Active only inside the app shell (window.MOBILE_APP). Web (browser) returns
// isNative=false and callers should use the normal web flow.

let reqId = 0;

const isAvailable = () =>
  typeof window !== "undefined" && window.MOBILE_APP && window.ReactNativeWebView;

export default function useMobileIAP() {
  const [products, setProducts] = useState([]);
  const [entitlement, setEntitlement] = useState({ plan: null, status: "inactive", expiresAt: null });
  const [loading, setLoading] = useState(false);
  const [accountId, setAccountId] = useState(null);
  const listeners = useRef(new Map());

  useEffect(() => {
    if (!isAvailable()) return;
    const handler = (event) => {
      const { id, kind, ...rest } = event.detail || event;
      const wait = listeners.current.get(id);
      if (!wait) return;
      listeners.current.delete(id);
      if (kind === "error") wait.reject(rest);
      else wait.resolve(rest);
    };
    window.addEventListener("handleIAPEvent", handler);
    if (!window.handleIAPEvent) {
      window.handleIAPEvent = (payload) =>
        window.dispatchEvent(new CustomEvent("handleIAPEvent", { detail: payload }));
    }
    // Bootstrap anonymous account + entitlement on mount
    (async () => {
      try {
        const id = await getAccountId("ios"); // platform refined at purchase time
        setAccountId(id);
        const ent = await getEntitlement(id);
        setEntitlement(ent);
      } catch (e) { /* ignore — will retry on purchase */ }
    })();
    return () => window.removeEventListener("handleIAPEvent", handler);
  }, []);

  const send = (type, extra = {}) =>
    new Promise((resolve, reject) => {
      if (!isAvailable()) return reject(new Error("IAP_UNAVAILABLE"));
      const id = `iap_${Date.now()}_${reqId++}`;
      listeners.current.set(id, { resolve, reject });
      window.ReactNativeWebView.postMessage(JSON.stringify({ type, id, ...extra }));
    });

  const loadProducts = useCallback(async (skus) => {
    setLoading(true);
    try {
      const res = await send("IAP_GET_PRODUCTS", { skus });
      setProducts(res.products || []);
      return res.products || [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshEntitlement = useCallback(async () => {
    if (!accountId) return;
    try {
      const ent = await getEntitlement(accountId);
      setEntitlement(ent);
    } catch (e) { /* non-fatal */ }
  }, [accountId]);

  const purchase = useCallback(async (sku) => {
    const res = await send("IAP_PURCHASE", { sku });
    await refreshEntitlement();
    return res;
  }, [refreshEntitlement]);

  const restore = useCallback(async () => {
    const res = await send("IAP_RESTORE");
    await refreshEntitlement();
    return res;
  }, [refreshEntitlement]);

  return {
    isNative: isAvailable(),
    products,
    entitlement,
    loading,
    accountId,
    loadProducts,
    purchase,
    restore
  };
}
