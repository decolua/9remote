"use client";

import { useEffect, useRef, useState } from "react";
import { FILE_WATCH } from "../constants/fileExplorer.js";

const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/";

// Keeps the agent watching exactly the directories the tree has open, and turns the
// resulting events into "reload these directories" callbacks.
//
// Four things keep this off the user's machine: only open directories are watched, never
// more than MAX_DIRS of them (oldest dropped first), nothing at all while the tab is
// hidden, and events are coalesced so a burst of writes costs one reload per directory.
export function useDirWatch({ dirs, fileSocket, onDirsChanged, enabled = true, debounceMs = FILE_WATCH.DEBOUNCE_MS }) {
  const watchedRef = useRef(new Set());
  // Read at event time so the debounce timer never captures a stale callback.
  const changedRef = useRef(onDirsChanged);
  useEffect(() => { changedRef.current = onDirsChanged; }, [onDirsChanged]);

  const { watchDir, unwatchDir, onFileChange } = fileSocket || {};
  // A stable string lets the sync effect depend on the contents, not the array identity.
  const key = dirs.join("\n");

  useEffect(() => {
    if (!enabled || !watchDir || !unwatchDir || typeof window === "undefined") return;

    let alive = true;
    const watched = watchedRef.current;
    const pending = new Set();
    let timer = null;

    // Deepest first: those are the folders the user drilled into, and the ones whose
    // contents change under them while they look at something else.
    const wanted = key ? key.split("\n") : [];
    const keep = new Set(
      [...wanted].sort((a, b) => b.split("/").length - a.split("/").length).slice(0, FILE_WATCH.MAX_DIRS)
    );

    const flush = () => {
      timer = null;
      if (!alive || !pending.size) return;
      const batch = [...pending];
      pending.clear();
      changedRef.current?.(batch);
    };

    const handler = ({ type, path }) => {
      if (!path) return;
      // "flooded" names the directory itself: the agent muzzled it and one reload of that
      // directory stands in for the events it swallowed.
      const dir = type === "flooded" ? path : parentOf(path);
      if (!keep.has(dir)) return;
      pending.add(dir);
      if (!timer) timer = setTimeout(flush, debounceMs);
    };

    const sync = async () => {
      for (const dir of watched) {
        if (keep.has(dir)) continue;
        watched.delete(dir);
        unwatchDir(dir);
      }
      for (const dir of keep) {
        if (watched.has(dir)) continue;
        watched.add(dir);
        const res = await watchDir(dir);
        // Refused (agent at its own cap) or the socket dropped mid-call: forget it so a
        // later sync can try again rather than believing it is covered.
        if (!alive || res?.watching === false) watched.delete(dir);
      }
    };

    const off = onFileChange?.(handler) || (() => {});
    sync();

    return () => {
      alive = false;
      clearTimeout(timer);
      off();
      for (const dir of watched) unwatchDir(dir);
      watched.clear();
    };
  }, [key, enabled, debounceMs, watchDir, unwatchDir, onFileChange]);
}

// True while the tab is visible. Watching a tree nobody can see is pure cost, so the
// watcher stands down until the user comes back — and the caller reloads once on return,
// since the events missed while hidden are gone.
export function usePageVisible() {
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}
