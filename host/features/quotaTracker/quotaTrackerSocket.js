// Quota tracker socket handlers — one aggregate `quota:get` request returning
// every provider. TTL-cached and in-flight-deduped so multiple connected
// clients polling at once cost one fetch round.
import { QUOTA_TTL_MS } from "./constants.js";
import { fetchClaudeQuota } from "./fetchers/claudeFetcher.js";
import { fetchCodexQuota } from "./fetchers/codexFetcher.js";
import { fetchKimiQuota } from "./fetchers/kimiFetcher.js";
import { fetchGrokQuota } from "./fetchers/grokFetcher.js";

const FETCHERS = {
  claude: fetchClaudeQuota,
  codex: fetchCodexQuota,
  kimi: fetchKimiQuota,
  grok: fetchGrokQuota
};

let cache = { ts: 0, result: null, pending: null };

async function fetchAll() {
  const entries = await Promise.all(Object.entries(FETCHERS).map(async ([provider, fetcher]) => {
    try {
      return [provider, await fetcher()];
    } catch (e) {
      return [provider, { provider, session: null, weekly: null, monthly: null, buckets: null, updatedAt: Date.now(), error: e?.message || String(e), status: "error" }];
    }
  }));
  return Object.fromEntries(entries);
}

export function setupQuotaTrackerHandlers(socket) {
  socket.on("quota:get", async (_payload, callback) => {
    const now = Date.now();
    if (cache.result && now - cache.ts < QUOTA_TTL_MS) {
      return callback?.({ success: true, providers: cache.result, cachedAt: cache.ts });
    }
    if (!cache.pending) {
      cache.pending = fetchAll()
        .then((result) => { cache = { ts: Date.now(), result, pending: null }; return result; })
        .catch(() => { cache.pending = null; return {}; });
    }
    try {
      const providers = await cache.pending;
      callback?.({ success: true, providers, cachedAt: cache.ts });
    } catch (e) {
      callback?.({ success: false, error: e?.message || "quota fetch failed" });
    }
  });
}
