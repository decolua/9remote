"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";

// One changed-file count per workspace root, covering the root repo and every repo under
// it. Ref-counted and shared, so the terminal badge and the git panel read the same
// number from a single poll instead of counting separately and disagreeing.
const entries = new Map(); // rootPath → { state, timer, refs, subs, fileSocket }

const EMPTY = { count: 0, perRepo: {} };

function fetchOnce(entry, rootPath) {
  entry.fileSocket?.gitWorkspaceChangedCount?.(rootPath).then((res) => {
    if (!res?.success) return;
    entry.state = { count: res.count || 0, perRepo: res.perRepo || {} };
    entry.subs.forEach((fn) => fn(entry.state));
  });
}

// Polling a repo nobody is looking at is pure cost, so a hidden tab stops and catches up
// on return rather than counting into the void.
function startTimer(entry, rootPath) {
  if (entry.timer || (typeof document !== "undefined" && document.hidden)) return;
  entry.timer = setInterval(() => fetchOnce(entry, rootPath), WORKSPACE_GIT_POLL_MS);
}

function stopTimer(entry) {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = null;
}

function acquire(rootPath, fileSocket) {
  let entry = entries.get(rootPath);
  if (!entry) {
    entry = { state: EMPTY, timer: null, refs: 0, subs: new Set(), fileSocket, onVisibility: null };
    entries.set(rootPath, entry);
    entry.onVisibility = () => {
      if (document.hidden) { stopTimer(entry); return; }
      fetchOnce(entry, rootPath);
      startTimer(entry, rootPath);
    };
    document.addEventListener("visibilitychange", entry.onVisibility);
    fetchOnce(entry, rootPath);
    startTimer(entry, rootPath);
  }
  entry.refs++;
  return entry;
}

function release(rootPath) {
  const entry = entries.get(rootPath);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  stopTimer(entry);
  document.removeEventListener("visibilitychange", entry.onVisibility);
  entries.delete(rootPath);
}

// Force a refresh for a workspace (after commit / discard) without waiting for the poll.
export function refreshWorkspaceChangedCount(rootPath) {
  const entry = entries.get(rootPath);
  if (entry) fetchOnce(entry, rootPath);
}

export function useWorkspaceChangedCount(rootPath, fileSocket, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!rootPath || !fileSocket || !enabled) return;
    const entry = acquire(rootPath, fileSocket);
    entry.subs.add(setState);
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(rootPath);
    };
  }, [rootPath, fileSocket, enabled]);

  return state;
}
