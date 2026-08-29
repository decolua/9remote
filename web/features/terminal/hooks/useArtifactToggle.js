"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";

// The agent owns this setting — it is the one writing each AI CLI's config file.
// The store value is a mirror kept fresh by serverInfo, so the toggle flips it
// optimistically and lets the agent's broadcast confirm or correct it.
export function useArtifactToggle(busRef, connected) {
  const enabled = useTerminalStore((s) => s.artifactEnabled);
  const setEnabled = useTerminalStore((s) => s.setArtifactEnabled);
  const supported = !!useTerminalStore((s) => s.agentCaps?.artifact);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  // A dropped bus never calls back, which would leave the switch stuck mid-flight.
  // Adjusted during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (!connected && loading) setLoading(false);

  // ToggleRow hands over the value it wants; fall back to flipping the current one.
  const toggle = useCallback((wanted) => {
    const bus = busRef?.current;
    if (!bus || !connected || loading) return;
    vibrate();
    const next = typeof wanted === "boolean" ? wanted : !enabled;
    setLoading(true);
    setEnabled(next);
    bus.emit("setArtifactEnabled", { enabled: next }, (result) => {
      if (!aliveRef.current) return;
      setLoading(false);
      // serverInfo lands with the same value; correcting here only matters on failure
      if (!result?.success) setEnabled(!next);
    });
  }, [busRef, connected, loading, enabled, setEnabled]);

  return { supported, enabled, loading, toggle };
}
