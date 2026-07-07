// Anonymous IAP API client. Works on web (same-origin /api) and inside WebView.
// Account is created lazily and cached in storage.

const ACCT_KEY = "iap_account_id";
const DEV_KEY = "iap_device_id";

async function getStore() {
  if (typeof localStorage !== "undefined") return localStorage;
  // Hide specifier from web bundler; only resolved in RN runtime
  const mod = "@react-native-async-storage/async-storage";
  const AsyncStorage = (await import(/* webpackIgnore: true */ mod)).default;
  return {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v)
  };
}

async function getDeviceId() {
  const store = await getStore();
  let id = await store.getItem(DEV_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await store.setItem(DEV_KEY, id);
  }
  return id;
}

export async function getAccountId(platform, providerAccount = null) {
  const store = await getStore();
  let accountId = await store.getItem(ACCT_KEY);
  if (accountId) return accountId;
  const deviceId = await getDeviceId();
  const base = apiBase();
  const res = await fetch(`${base}/api/iap/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, platform, providerAccount })
  });
  if (!res.ok) throw new Error(`account failed: ${res.status}`);
  const data = await res.json();
  accountId = data.data.accountId;
  await store.setItem(ACCT_KEY, accountId);
  return accountId;
}

export async function getEntitlement(accountId) {
  const res = await fetch(`${apiBase()}/api/iap/entitlement?accountId=${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`entitlement failed: ${res.status}`);
  const data = await res.json();
  return data.data;
}

export async function verifyPurchase({ accountId, platform, productId, transactionId, receipt, purchaseToken }) {
  const res = await fetch(`${apiBase()}/api/iap/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, platform, productId, transactionId, receipt, purchaseToken })
  });
  const data = await res.json();
  if (!res.ok || !data.data?.verified) throw new Error(data.error || data.data?.error || "verify failed");
  return data.data;
}

function apiBase() {
  // Inside WebView, use same-origin (web domain). Native shell calls absolute URL via injected config.
  if (typeof window !== "undefined" && window.location && window.location.origin && !window.MOBILE_APP) {
    return window.location.origin;
  }
  return typeof window !== "undefined" && window.API_BASE ? window.API_BASE : "";
}
