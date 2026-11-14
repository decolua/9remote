"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import { GIT_AUTO_REFRESH_EVENTS, GIT_STATUS_DEBOUNCE_MS } from "@/features/fileExplorer/constants/fileExplorer.js";

// The only changed-file count lane: one ref-counted, single-flight poll per workspace
// root. The pane badge, the git panel and the status bars all derive their number from
// this one snapshot, so no two surfaces can poll separately and disagree.
const entries = new WeakMap(); // fileBus → Map(rootPath → { state, stop, refs, subs })

const EMPTY = { count: 0, perRepo: {} };

// One quick retry after a transient failure (bus reconnect) — otherwise the badge
// stays hidden a full poll cycle.
const RETRY_MS = 1500;
// A request whose ack never lands must not wedge the lane forever.
const REQUEST_TIMEOUT_MS = 8000;

const samePerRepo = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

function mapFor(fileBus) {
  let map = entries.get(fileBus);
  if (!map) {
    map = new Map();
    entries.set(fileBus, map);
  }
  return map;
}

// Count for a path from the shared snapshot: the deepest repo containing it, so a
// nested repo's pane shows its own number, not the whole workspace's. Falls back to
// the workspace total when the path is not inside any counted repo.
export function countAt(perRepo, targetPath, fallback = 0) {
  if (!targetPath) return fallback;
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(targetPath);
  let best = null;
  let bestLen = -1;
  for (const [repoPath, count] of Object.entries(perRepo || {})) {
    const key = norm(repoPath);
    if (!key) continue;
    if ((target === key || target.startsWith(`${key}/`)) && key.length > bestLen) {
      best = count;
      bestLen = key.length;
    }
  }
  return best === null ? fallback : best;
}

function fetchOnce(entry, rootPath, force, retries = 1) {
  if (entry.refs <= 0) return;
  // One request in flight per entry; a late force request runs right after it.
  if (entry.inflight) {
    if (force && !entry.inflightForce) entry.forceQueued = true;
    return;
  }
  const request = entry.fileBus?.gitWorkspaceChangedCount?.(rootPath, undefined, force);
  if (!request?.then) return;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
  });
  entry.inflight = true;
  entry.inflightForce = !!force;
  Promise.race([request.catch(() => null), timeout]).then((res) => {
    clearTimeout(timer);
    entry.inflight = false;
    entry.inflightForce = false;
    if (entry.refs <= 0) return;
    if (entry.forceQueued) {
      entry.forceQueued = false;
      fetchOnce(entry, rootPath, true);
    }
    if (!res?.success) {
      if (retries > 0) setTimeout(() => fetchOnce(entry, rootPath, force, retries - 1), RETRY_MS);
      return;
    }
    const count = res.count || 0;
    const perRepo = res.perRepo || {};
    // Unchanged numbers must not re-render every subscribed pane.
    if (entry.state.count === count && samePerRepo(entry.state.perRepo, perRepo)) return;
    entry.state = { count, perRepo };
    entry.subs.forEach((fn) => fn(entry.state));
  });
}

function acquire(rootPath, fileBus) {
  const map = mapFor(fileBus);
  let entry = map.get(rootPath);
  if (!entry) {
    entry = {
      state: EMPTY, stop: null, refs: 0, subs: new Set(), fileBus,
      refreshNow: null, refreshTimer: null,
      inflight: false, inflightForce: false, forceQueued: false
    };
    map.set(rootPath, entry);
    // Ref counted up front so the initial fetch below passes the refs guard in fetchOnce.
    entry.refs++;
    // Save/commit/refresh events mean the count moved — refetch FORCED (the host's TTL
    // would happily answer with the pre-event number) and debounced, so an agent's burst
    // of writes costs one round-trip. One listener per root, not per subscriber.
    entry.refreshNow = () => {
      clearTimeout(entry.refreshTimer);
      entry.refreshTimer = setTimeout(() => fetchOnce(entry, rootPath, true), GIT_STATUS_DEBOUNCE_MS);
    };
    GIT_AUTO_REFRESH_EVENTS.forEach((ev) => window.addEventListener(ev, entry.refreshNow));
    fetchOnce(entry, rootPath);
    entry.stop = pollWhileVisible(() => fetchOnce(entry, rootPath), WORKSPACE_GIT_POLL_MS);
    return entry;
  }
  entry.refs++;
  return entry;
}

function release(rootPath, fileBus) {
  const map = entries.get(fileBus);
  const entry = map?.get(rootPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.stop?.();
  clearTimeout(entry.refreshTimer);
  GIT_AUTO_REFRESH_EVENTS.forEach((ev) => window.removeEventListener(ev, entry.refreshNow));
  map.delete(rootPath);
}

// Force a refresh for a workspace (after commit / discard / refresh button) without
// waiting for the poll. Shares the single-flight lane, so it cannot stack a second
// `git status` on top of the one already running. `force` bypasses the host TTL cache.
export function refreshWorkspaceChangedCount(rootPath, fileBus) {
  const entry = entries.get(fileBus)?.get(rootPath);
  if (entry) fetchOnce(entry, rootPath, true);
}

export function useWorkspaceChangedCount(rootPath, fileBus, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!rootPath || !fileBus || !enabled) return;
    const entry = acquire(rootPath, fileBus);
    entry.subs.add(setState);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latch shared entry state on subscribe; identity-guarded
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(rootPath, fileBus);
    };
  }, [rootPath, fileBus, enabled]);

  return state;
}
