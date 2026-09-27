// The daemon's per-process KV: state that belongs to a process the daemon holds.
//
// The daemon is where the process lives, so it is where the process's own facts
// survive an agent restart — the chat's token counters and its turn marker. The
// agent writes them at a turn's edges and reads them back when it rebuilds the
// session; it keeps only the key. Values are cloned on the way in so the agent's
// objects and the daemon's copy cannot drift apart by mutation.
//
// Memory only, deliberately: a daemon restart drops the counters with it, and the
// transcripts remain the authority a full rebuild can always fall back to. A cap
// sheds the oldest key so a long-lived daemon cannot grow without bound.

/** A JSON-cloning store with a hard cap. */
export function createKvStore(cap = 500) {
  const entries = new Map(); // insertion-ordered: oldest first, the first shed
  return {
    set(key, value) {
      if (typeof key !== "string" || !key) return false;
      entries.delete(key); // re-inserted keys go to the fresh end
      entries.set(key, structuredClone(value ?? null));
      if (entries.size > cap) entries.delete(entries.keys().next().value);
      return true;
    },
    get(key) {
      return entries.has(key) ? structuredClone(entries.get(key)) : null;
    },
    del(key) {
      return entries.delete(key);
    },
    get size() {
      return entries.size;
    }
  };
}

/**
 * The route handlers. The store arrives as `deps.kv` — ptyDaemon creates it beside
 * its sessions map and hands it to the router, and a test builds its own router
 * with its own store the same way.
 */
export const kvRoutes = {
  set: (m, deps) => ({ success: deps.kv.set(m.key, m.value) }),
  get: (m, deps) => ({ success: true, value: deps.kv.get(m.key) }),
  del: (m, deps) => ({ success: deps.kv.del(m.key) })
};
