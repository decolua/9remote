"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// How long the reconnect modal stays suppressed after a resume
const RESUME_GRACE_MS = 4000;
const UPDATE_STORAGE_KEY = "9remote_agent_updating";
const UPDATE_MAX_DURATION_MS = 95000;

function getSavedUpdateState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(UPDATE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data.startedAt || 0) < UPDATE_MAX_DURATION_MS) {
      return data;
    }
    sessionStorage.removeItem(UPDATE_STORAGE_KEY);
  } catch {}
  return null;
}

// Agent self-update / host-restart flow plus the PWA resume grace window that
// suppresses the ConnectionModal while the connection re-establishes.
// Uses persistent sessionStorage so an in-flight update is never forgotten on page refresh.
export function useAgentUpdate({ connected, triggerUpdate, triggerRestart }) {
  const [updating, setUpdating] = useState(() => !!getSavedUpdateState());
  const [updateMode, setUpdateMode] = useState(() => getSavedUpdateState()?.mode || "update");
  const [resumeGrace, setResumeGrace] = useState(false);

  // Tab becomes visible again after background: WS/RTC take ~1-2s to re-establish.
  // Suppress the modal during this window so it doesn't flash on every resume.
  const graceTimerRef = useRef(null);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setResumeGrace(true);
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
    if (triggerUpdate()) {
      setUpdateMode("update");
      setUpdating(true);
      try {
        sessionStorage.setItem(UPDATE_STORAGE_KEY, JSON.stringify({ mode: "update", startedAt: Date.now() }));
      } catch {}
    }
  }, [triggerUpdate]);

  const doRestart = useCallback(() => {
    if (triggerRestart()) {
      setUpdateMode("restart");
      setUpdating(true);
      try {
        sessionStorage.setItem(UPDATE_STORAGE_KEY, JSON.stringify({ mode: "restart", startedAt: Date.now() }));
      } catch {}
    }
  }, [triggerRestart]);

  const cancelUpdate = useCallback(() => {
    try { sessionStorage.removeItem(UPDATE_STORAGE_KEY); } catch {}
    setUpdating(false);
  }, []);

  // When agent reconnects after restart: clear storage and reload page cleanly
  const diedOnceRef = useRef(false);

  useEffect(() => {
    if (!updating) {
      diedOnceRef.current = false;
      return;
    }
    if (!connected) {
      diedOnceRef.current = true;
    } else if (diedOnceRef.current && connected) {
      try { sessionStorage.removeItem(UPDATE_STORAGE_KEY); } catch {}
      const timer = setTimeout(() => {
        window.location.reload();
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [connected, updating]);

  // Safety net: auto-dismiss updating state if restart takes longer than 95s
  useEffect(() => {
    if (!updating) return;
    const timer = setTimeout(() => {
      try { sessionStorage.removeItem(UPDATE_STORAGE_KEY); } catch {}
      setUpdating(false);
    }, UPDATE_MAX_DURATION_MS);
    return () => clearTimeout(timer);
  }, [updating]);

  return { updating, updateMode, resumeGrace, doUpdate, doRestart, cancelUpdate };
}
