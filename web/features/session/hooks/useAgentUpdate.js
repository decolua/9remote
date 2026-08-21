"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// How long the reconnect modal stays suppressed after a resume
const RESUME_GRACE_MS = 4000;

// Agent self-update / host-restart flow plus the PWA resume grace window that
// suppresses the ConnectionModal while the connection re-establishes.
export function useAgentUpdate({ connected, triggerUpdate, triggerRestart }) {
  const [updating, setUpdating] = useState(false);
  const [updateMode, setUpdateMode] = useState("update");
  const [resumeGrace, setResumeGrace] = useState(false);

  // Tab becomes visible again after background: WS/RTC take ~1-2s to re-establish.
  // Suppress the modal during this window so it doesn't flash on every resume.
  const graceTimerRef = useRef(null);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setResumeGrace(true);
      // Restart the window instead of stacking: back-to-back resumes used to
      // let the FIRST timer end the grace early, flashing the modal while the
      // newest resume was still reconnecting.
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => setResumeGrace(false), RESUME_GRACE_MS);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearTimeout(graceTimerRef.current);
    };
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
