"use client";

import { Terminal, Zap, Sparkles, History, Star, RotateCw } from "@/shared/components/ui/Icon";

const CARDS = [
  {
    key: "total",
    label: "Total",
    icon: Terminal,
    color: "text-text",
    iconColor: "text-text-muted bg-surface-2"
  },
  {
    key: "online",
    label: "Online (30m)",
    icon: Zap,
    color: "text-success",
    iconColor: "text-success bg-emerald-500/10",
    pulse: true
  },
  {
    key: "newToday",
    label: "New (24h)",
    icon: Sparkles,
    color: "text-brand-500",
    iconColor: "text-brand-500 bg-brand-500/10"
  },
  {
    key: "retention7d",
    label: "Retention 7d",
    icon: History,
    color: "text-text",
    iconColor: "text-text-muted bg-surface-2",
    suffix: "%"
  },
  {
    key: "stickiness",
    label: "Stickiness",
    icon: Star,
    color: "text-amber-500",
    iconColor: "text-amber-500 bg-amber-500/10",
    suffix: "%"
  },
  {
    key: "avgLifespanDays",
    label: "Avg Lifespan",
    icon: RotateCw,
    color: "text-text",
    iconColor: "text-text-muted bg-surface-2",
    suffix: "d"
  }
];

export default function StatsCards({ stats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
      {CARDS.map((c) => {
        const Icon = c.icon;
        const val = stats?.[c.key];
        return (
          <div
            key={c.key}
            className="card-glass p-4 relative overflow-hidden"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-mono tracking-wider uppercase text-text-muted truncate">
                {c.label}
              </span>
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${c.iconColor}`}>
                <Icon size={14} />
              </div>
            </div>

            <div className="flex items-baseline gap-1.5 mt-1">
              <div className={`text-xl sm:text-2xl font-bold tracking-tight font-mono ${c.color}`}>
                {val ?? "-"}
              </div>
              {val != null && c.suffix && (
                <span className="text-xs font-mono text-text-subtle font-semibold">{c.suffix}</span>
              )}
            </div>

            {c.pulse && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span className="text-[10px] font-mono text-emerald-500 font-medium">live</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
