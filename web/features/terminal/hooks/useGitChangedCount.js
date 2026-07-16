import { useEffect, useState } from "react";

// Shared, ref-counted git changed-count per cwd. One 10s poll per unique cwd
// regardless of how many panes share it → all panes stay in sync.
const POLL_MS = 10000;
const entries = new Map(); // cwd → { count, timer, refs, subs, fileSocket }

function notify(entry) {
  entry.subs.forEach((fn) => fn(entry.count));
}

function fetchOnce(entry, cwd) {
  entry.fileSocket?.gitChangedCount(cwd).then((res) => {
    if (!res?.success) return;
    entry.count = res.count || 0;
    notify(entry);
  });
}

function acquire(cwd, fileSocket) {
  let entry = entries.get(cwd);
  if (!entry) {
    entry = { count: 0, timer: null, refs: 0, subs: new Set(), fileSocket };
    entries.set(cwd, entry);
    fetchOnce(entry, cwd);
    entry.timer = setInterval(() => fetchOnce(entry, cwd), POLL_MS);
  }
  entry.refs++;
  return entry;
}

function release(cwd) {
  const entry = entries.get(cwd);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    if (entry.timer) clearInterval(entry.timer);
    entries.delete(cwd);
  }
}

export function useGitChangedCount(cwd, fileSocket, { enabled = true } = {}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!cwd || !fileSocket || !enabled) return;
    const entry = acquire(cwd, fileSocket);
    setCount(entry.count);
    entry.subs.add(setCount);
    return () => {
      entry.subs.delete(setCount);
      release(cwd);
    };
  }, [cwd, fileSocket, enabled]);

  return count;
}
