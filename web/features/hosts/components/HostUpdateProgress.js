"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";

// Self-update is opaque from the web: the CLI process does the work while the
// host's server dies mid-way, so nothing continuous can flow over the bus.
// Progress is a phased estimate over the known timeline instead. Only the bar
// shows — the phase text rides along as the tooltip.
const PHASES = [
  { start: 0, until: 50, pct: [0, 70], key: "menu.updateInstalling" },
  { start: 50, until: 80, pct: [70, 90], key: "menu.updateRestarting" },
  { start: 80, until: 95, pct: [90, 99], key: "menu.updateReconnecting" }
];
const LAST = PHASES[PHASES.length - 1];

export default function HostUpdateProgress({ className = "" }) {
  const { t } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 500);
    return () => clearInterval(timer);
  }, []);

  const phase = PHASES.find((p) => elapsed < p.until) || LAST;
  const frac = Math.min(1, Math.max(0, (elapsed - phase.start) / (phase.until - phase.start)));
  const pct = Math.round(phase.pct[0] + (phase.pct[1] - phase.pct[0]) * frac);

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`} title={`${t(phase.key)} — ${pct}%`}>
      <Loader2 size={12} className="animate-spin text-brand-400 shrink-0" />
      <span className="h-1 flex-1 min-w-[60px] rounded-full bg-surface-2 overflow-hidden">
        <span
          className="block h-full bg-brand-500 rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
