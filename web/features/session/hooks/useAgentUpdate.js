"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// Agent self-update / host-restart flow plus the PWA resume grace window that
// suppresses the ConnectionModal while the connection re-establishes.
export function useAgentUpdate({ connected, triggerUpdate, triggerRestart }) {
  const [updating, setUpdating] = useState(false);
  const [updateMode, setUpdateMode] = useState("update");
  const [resumeGrace, setResumeGrace] = useState(false);

  // Tab becomes visible again after background: WS/RTC take ~1-2s to re-establish.
  // Suppress the modal during this window so it doesn't flash on every resume.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        setResumeGrace(true);
        setTimeout(() => setResumeGrace(false), 4000);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const doUpdate = useCallback(() => {
    if (triggerUpdate()) { setUpdateMode("update"); setUpdating(true); }
  }, [triggerUpdate]);

  // RTC-first: after a self-update the agent restarts and RTC usually reopens before the
  // WS tunnel. Clear the overlay on the reconnect EDGE (false→true) only — clearing while
  // still connected would hide the modal before the agent has even restarted.
  const prevConnRef = useRef(connected);
  useEffect(() => {
    if (updating && connected && !prevConnRef.current) setUpdating(false);
    prevConnRef.current = connected;
  }, [connected, updating]);

  // Host restart (no reinstall): WS reconnect handles the ~2s gap, ConnectionModal covers it.
  const doRestart = useCallback(() => {
    triggerRestart();
  }, [triggerRestart]);

  return { updating, updateMode, resumeGrace, doUpdate, doRestart };
}
