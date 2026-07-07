"use client";

const CARDS = [
  { key: "total", label: "Total", color: "text-text" },
  { key: "online", label: "Online (30m)", color: "text-success" },
  { key: "newToday", label: "New (24h)", color: "text-success" },
  { key: "retention7d", label: "Retention 7d", color: "text-brand-500", suffix: "%" },
  { key: "stickiness", label: "Stickiness", color: "text-brand-400", suffix: "%" },
  { key: "avgLifespanDays", label: "Avg lifespan", color: "text-text", suffix: "d" }
];

export default function StatsCards({ stats }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
      {CARDS.map((c) => (
        <div key={c.key} className="card-soft p-4 border border-border-subtle">
          <div className="text-xs sm:text-sm text-text-muted">{c.label}</div>
          <div className={`text-2xl sm:text-3xl font-bold mt-1 ${c.color}`}>
            {stats?.[c.key] ?? "-"}{stats?.[c.key] != null && c.suffix ? c.suffix : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
