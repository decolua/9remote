// Re-parse cadence for client-side screen mode: the buffer changes constantly, but the
// chat view only needs human-scale freshness.
import { useEffect, useState } from "react";

const TICK_MS = 500;

export function useScreenTick(enabled) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return enabled ? tick : 0;
}
