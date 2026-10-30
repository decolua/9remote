"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import { GIT_AUTO_REFRESH_EVENTS, GIT_STATUS_DEBOUNCE_MS } from "@/features/fileExplorer/constants/fileExplorer.js";

// One changed-file count per workspace root, covering the root repo and every repo under
// it. Ref-counted and shared, so the terminal badge and the git panel read the same
// number from a single poll instead of counting separately and disagreeing.
const entries = new Map(); // rootPath → { state, stop, refs, subs, fileBus, refreshNow }

const EMPTY = { count: 0, perRepo: {} };

// One quick retry after a transient failure (bus reconnect) — otherwise the badge
// stays hidden a full poll cycle.
const RETRY_MS = 1500;

const samePerRepo = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

function fetchOnce(entry, rootPath, force, retries = 1) {
  if (entry.refs <= 0) return;
  entry.fileBus?.gitWorkspaceChangedCount?.(rootPath, undefined, force).then((res) => {
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
  let entry = entries.get(rootPath);
  if (!entry) {
    entry = { state: EMPTY, stop: null, refs: 0, subs: new Set(), fileBus, refreshNow: null, refreshTimer: null };
    entries.set(rootPath, entry);
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

function release(rootPath) {
  const entry = entries.get(rootPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.stop?.();
  clearTimeout(entry.refreshTimer);
  GIT_AUTO_REFRESH_EVENTS.forEach((ev) => window.removeEventListener(ev, entry.refreshNow));
  entries.delete(rootPath);
}

// Force a refresh for a workspace (after commit / discard / refresh button) without
// waiting for the poll. `force` bypasses the agent-side TTL cache so the number is live.
export function refreshWorkspaceChangedCount(rootPath) {
  const entry = entries.get(rootPath);
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
      release(rootPath);
    };
  }, [rootPath, fileBus, enabled]);

  return state;
}
