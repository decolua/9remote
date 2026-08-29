"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_GIT_POLL_MS } from "../constants/terminalConfig";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";

// One changed-file count per workspace root, covering the root repo and every repo under
// it. Ref-counted and shared, so the terminal badge and the git panel read the same
// number from a single poll instead of counting separately and disagreeing.
const entries = new Map(); // rootPath → { state, stop, refs, subs, fileBus }

const EMPTY = { count: 0, perRepo: {} };

function fetchOnce(entry, rootPath) {
  entry.fileBus?.gitWorkspaceChangedCount?.(rootPath).then((res) => {
    if (!res?.success) return;
    entry.state = { count: res.count || 0, perRepo: res.perRepo || {} };
    entry.subs.forEach((fn) => fn(entry.state));
  });
}

function acquire(rootPath, fileBus) {
  let entry = entries.get(rootPath);
  if (!entry) {
    entry = { state: EMPTY, stop: null, refs: 0, subs: new Set(), fileBus };
    entries.set(rootPath, entry);
    fetchOnce(entry, rootPath);
    entry.stop = pollWhileVisible(() => fetchOnce(entry, rootPath), WORKSPACE_GIT_POLL_MS);
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
  entries.delete(rootPath);
}

// Force a refresh for a workspace (after commit / discard) without waiting for the poll.
export function refreshWorkspaceChangedCount(rootPath) {
  const entry = entries.get(rootPath);
  if (entry) fetchOnce(entry, rootPath);
}

export function useWorkspaceChangedCount(rootPath, fileBus, { enabled = true } = {}) {
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!rootPath || !fileBus || !enabled) return;
    const entry = acquire(rootPath, fileBus);
    entry.subs.add(setState);
    setState((prev) => (prev === entry.state ? prev : entry.state));
    return () => {
      entry.subs.delete(setState);
      release(rootPath);
    };
  }, [rootPath, fileBus, enabled]);

  return state;
}
