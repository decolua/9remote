import { useEffect, useState } from "react";
import { pollWhileVisible } from "@/shared/utils/visibilityPoll";

// Shared, ref-counted git changed-count per cwd. One 10s poll per unique cwd
// regardless of how many panes share it → all panes stay in sync.
const POLL_MS = 10000;
const entries = new Map(); // cwd → { count, stop, refs, subs, fileBus }

function notify(entry) {
  entry.subs.forEach((fn) => fn(entry.count));
}

function fetchOnce(entry, cwd) {
  entry.fileBus?.gitChangedCount(cwd).then((res) => {
    if (!res?.success) return;
    entry.count = res.count || 0;
    notify(entry);
  });
}

function acquire(cwd, fileBus) {
  let entry = entries.get(cwd);
  if (!entry) {
    entry = { count: 0, stop: null, refs: 0, subs: new Set(), fileBus };
    entries.set(cwd, entry);
    fetchOnce(entry, cwd);
    entry.stop = pollWhileVisible(() => fetchOnce(entry, cwd), POLL_MS);
  }
  entry.refs++;
  return entry;
}

function release(cwd) {
  const entry = entries.get(cwd);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.stop?.();
    entries.delete(cwd);
  }
}

export function useGitChangedCount(cwd, fileBus, { enabled = true } = {}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!cwd || !fileBus || !enabled) return;
    const entry = acquire(cwd, fileBus);
    setCount(entry.count);
    entry.subs.add(setCount);
    return () => {
      entry.subs.delete(setCount);
      release(cwd);
    };
  }, [cwd, fileBus, enabled]);

  return count;
}
