"use client";

import { useEffect, useState } from "react";
import { QUOTA_POLL_MS } from "../constants/quotaConfig";

// Polls the agent's aggregate quota:get (agent caches for 60s server-side).
// Returns null until the first successful response.
export function useQuota(socketRef, { enabled = true } = {}) {
  const [quota, setQuota] = useState(null);

  useEffect(() => {
    if (!enabled || !socketRef) return;
    let cancelled = false;
    const fetchQuota = () => {
      if (!socketRef.current) return;
      socketRef.current.emit("quota:get", {}, (res) => {
        if (!cancelled && res?.success && res.providers) setQuota(res);
      });
    };
    fetchQuota();
    const timer = setInterval(fetchQuota, QUOTA_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [socketRef, enabled]);

  return quota;
}
