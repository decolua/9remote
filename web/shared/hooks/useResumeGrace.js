"use client";

import { useEffect, useRef, useState } from "react";

const RESUME_GRACE_MS = 4000;

// PWA/tab resume: WS/RTC take ~1-2s to re-establish — suppress connection
// modals for a beat so they don't flash on every reopen.
export function useResumeGrace() {
  const [resumeGrace, setResumeGrace] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      setResumeGrace(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setResumeGrace(false), RESUME_GRACE_MS);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearTimeout(timerRef.current);
    };
  }, []);
  return resumeGrace;
}
