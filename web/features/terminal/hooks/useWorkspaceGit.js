"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";
import { useFileBusStore } from "@/shared/stores/fileBusStore";

// Shared, ref-counted git branch per workspace path — one poll per unique path no
// matter how many terminals sit in that workspace. Change counts are NOT read here:
// they belong to useWorkspaceChangedCount's single lane, so every badge and status bar
// reads the same snapshot.
const entries = new WeakMap(); // fileBus → Map(path → entry)

const EMPTY = { branch: null };
// An ack that never lands must not wedge the branch poll forever.
const REQUEST_TIMEOUT_MS = 8000;

function mapFor(fileBus) {
  let map = entries.get(fileBus);
  if (!map) {
    map = new Map();
    entries.set(fileBus, map);
  }
  return map;
}

function fetchOnce(entry, wsPath) {
  if (entry.refs <= 0 || entry.inflight) return;
  const request = entry.fileBus?.gitBranch?.(wsPath);
  if (!request?.then) return;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
  });
  entry.inflight = true;
  Promise.race([request.catch(() => null), timeout]).then((res) => {
    clearTimeout(timer);
    entry.inflight = false;
    if (entry.refs <= 0) return;
    const branch = res?.success ? res.branch || null : null;
    if (entry.state.branch === branch) return;
    entry.state = { branch };
    entry.subs.forEach((fn) => fn(entry.state));
  });
}

function acquire(wsPath, fileBus) {
  const map = mapFor(fileBus);
  let entry = map.get(wsPath);
  if (!entry) {
    entry = { state: EMPTY, stop: null, refs: 0, subs: new Set(), fileBus, inflight: false };
    map.set(wsPath, entry);
    // Ref counted up front so the initial fetch below passes the refs guard in fetchOnce.
    entry.refs++;
    fetchOnce(entry, wsPath);
    entry.stop = pollWhileVisible(() => fetchOnce(entry, wsPath), WORKSPACE_GIT_POLL_MS);
    return entry;
  }
  entry.refs++;
  return entry;
}

function release(wsPath, fileBus) {
  const map = entries.get(fileBus);
  const entry = map?.get(wsPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.stop?.();
  map.delete(wsPath);
}

// Force a refresh for a path (after checkout) without waiting for the poll.
export function refreshWorkspaceGit(wsPath, fileBus = useFileBusStore.getState()) {
  const entry = entries.get(fileBus)?.get(wsPath);
  if (entry) fetchOnce(entry, wsPath);
}

export function useWorkspaceGit(wsPath, propFileBus, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);
  const fileBus = propFileBus || useFileBusStore.getState();

  useEffect(() => {
    if (!wsPath || !fileBus || !enabled) return;
    const entry = acquire(wsPath, fileBus);
    entry.subs.add(setState);
    // Adopt whatever the shared entry already knows, without a redundant render when
    // this is the subscriber that just created it.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latch shared entry state on subscribe; identity-guarded
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(wsPath, fileBus);
    };
  }, [wsPath, fileBus, enabled]);

  return state;
}
