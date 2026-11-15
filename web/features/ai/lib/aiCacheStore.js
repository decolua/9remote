// IndexedDB access for the AI pane's best-effort replay cache.
//
// Rules (see lib/aiCache): the cache is never authoritative, so every failure here
// must be silent — one error disables the cache for the rest of the page and the
// pane falls back to the host hydrate exactly as before. WebKit's storage guidance
// asks for short-lived connections, so each operation opens the database, runs, and
// closes it again.

import {
  AI_CACHE_MAX_AGE_MS,
  AI_CACHE_MAX_ENTRIES,
  AI_CACHE_TOTAL_BYTES,
  parseCacheEntry,
  selectPrunable
} from "./aiCache";

const DB_NAME = "9remote-cache";
const DB_VERSION = 1;
const STORE = "aiTail";
const OPEN_TIMEOUT_MS = 2000;
const FLAG_KEY = "9remote:aiCache";

let disabled = false;
let pruneInFlight = false;
// After an explicit clear (logout / device rejected) nothing may be written again
// on this page — a pane unmounting during the redirect must not resurrect content.
let cleared = false;

/** Build-time flag, with a runtime override for testing on a real device. */
export function aiCacheEnabled() {
  if (typeof window === "undefined") return false;
  try {
    const flag = window.localStorage.getItem(FLAG_KEY);
    if (flag === "1") return true;
    if (flag === "0") return false;
  } catch {}
  return process.env.NEXT_PUBLIC_AI_CACHE === "1";
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no-idb")); return; }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("idb-open-timeout"));
    }, OPEN_TIMEOUT_MS);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      if (settled) { try { req.result.close(); } catch {} return; }
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error || new Error("idb-open"));
    };
  });
}

/** One door for every operation; null on any failure, and the cache stands down. */
async function withDb(fn, { force = false } = {}) {
  if (!force && (disabled || !aiCacheEnabled())) return null;
  let db = null;
  try {
    db = await openDb();
    return await fn(db);
  } catch {
    disabled = true;
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function request(req) {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

/** Raw stored entry for one key; the caller validates it with aiCache. */
export function readAiCache(key) {
  return withDb(async (db) => {
    const tx = db.transaction(STORE, "readonly");
    const raw = await request(tx.objectStore(STORE).get(key));
    const entry = parseCacheEntry(raw);
    // A corrupt or expired entry is dead weight — reclaim its slot on the way past.
    if (raw != null && (!entry || Date.now() - entry.ts > AI_CACHE_MAX_AGE_MS)) {
      deleteAiCache(key);
      return null;
    }
    return entry;
  });
}

export function writeAiCache(key, entry) {
  if (cleared) return null;
  return withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry, key);
    await new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
    // Fire-and-forget: the store's own size bound is what matters, not this call.
    pruneAiCache();
    return true;
  });
}

export function deleteAiCache(key) {
  if (cleared) return null;
  return withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    return true;
  });
}

export function clearAiCache() {
  cleared = true;
  // Force: a cache written under a flag that has since been turned off must still go.
  return withDb(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    return true;
  }, { force: true });
}

/** Keep the newest entries under both caps; older ones are pure waste. */
export async function pruneAiCache({
  maxEntries = AI_CACHE_MAX_ENTRIES, maxBytes = AI_CACHE_TOTAL_BYTES
} = {}) {
  if (pruneInFlight) return;
  pruneInFlight = true;
  try {
    await withDb(async (db) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      if (!keys || !values) return;
      const rows = keys.map((key, i) => ({ key, ts: values[i]?.ts || 0, bytes: values[i]?.bytes }));
      const drop = selectPrunable(rows, { maxEntries, maxBytes });
      if (!drop.length) return;
      const wtx = db.transaction(STORE, "readwrite");
      const wstore = wtx.objectStore(STORE);
      for (const key of drop) wstore.delete(key);
      return true;
    });
  } finally {
    pruneInFlight = false;
  }
}

/** Test hook: a failure disables the cache for the page; this re-arms it. */
export function resetAiCacheCircuit() {
  disabled = false;
  pruneInFlight = false;
  cleared = false;
}
