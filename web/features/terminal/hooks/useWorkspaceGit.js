"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";

// Shared, ref-counted git branch + dirty flag per workspace path. One poll per unique
// path no matter how many terminals sit in that workspace — otherwise 10 terminals in
// one repo mean 10 identical `git` calls every tick.
const entries = new Map(); // path → { state, timer, refs, subs, fileSocket }

const EMPTY = { branch: null, dirty: false, changedCount: 0 };

function notify(entry) {
  entry.subs.forEach((fn) => fn(entry.state));
}

async function fetchOnce(entry, wsPath) {
  const [branchRes, countRes] = await Promise.all([
    entry.fileSocket?.gitBranch?.(wsPath),
    entry.fileSocket?.gitChangedCount?.(wsPath)
  ]);
  const branch = branchRes?.success ? branchRes.branch || null : null;
  const changedCount = countRes?.success ? countRes.count || 0 : 0;
  if (entry.state.branch === branch && entry.state.changedCount === changedCount) return;
  entry.state = { branch, dirty: changedCount > 0, changedCount };
  notify(entry);
}

function acquire(wsPath, fileSocket) {
  let entry = entries.get(wsPath);
  if (!entry) {
    entry = { state: EMPTY, timer: null, refs: 0, subs: new Set(), fileSocket };
    entries.set(wsPath, entry);
    fetchOnce(entry, wsPath);
    entry.timer = setInterval(() => fetchOnce(entry, wsPath), WORKSPACE_GIT_POLL_MS);
  }
  entry.refs++;
  return entry;
}

function release(wsPath) {
  const entry = entries.get(wsPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  if (entry.timer) clearInterval(entry.timer);
  entries.delete(wsPath);
}

// Force a refresh for a path (after checkout / commit) without waiting for the poll.
export function refreshWorkspaceGit(wsPath) {
  const entry = entries.get(wsPath);
  if (entry) fetchOnce(entry, wsPath);
}

export function useWorkspaceGit(wsPath, fileSocket, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!wsPath || !fileSocket || !enabled) return;
    const entry = acquire(wsPath, fileSocket);
    entry.subs.add(setState);
    // Adopt whatever the shared entry already knows, without a redundant render when
    // this is the subscriber that just created it.
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(wsPath);
    };
  }, [wsPath, fileSocket, enabled]);

  return state;
}
