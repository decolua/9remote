"use client";

import { Trash2, ArrowUp, ArrowDown, Terminal } from "@/shared/components/ui/Icon";
import { SESSION_SORT_FIELDS, SESSION_ONLINE_THRESHOLD_MS, LOYALTY_TIERS } from "../constants";

const COLUMNS = [
  { key: "machineId", label: "Machine ID", sortable: true },
  { key: "publicIp", label: "Public IP", sortable: false },
  { key: "localIp", label: "Local IP", sortable: false },
  { key: "createdAt", label: "Created", sortable: true },
  { key: "lastAccessAt", label: "Last Access", sortable: true },
  { key: "expiresAt", label: "Expires", sortable: true }
];

const SORT_OPTIONS = COLUMNS.filter((c) => c.sortable);

function isOnline(session) {
  const ref = session?.lastAccessAt || session?.createdAt;
  if (!ref) return false;
  return Date.now() - new Date(ref + "Z").getTime() < SESSION_ONLINE_THRESHOLD_MS;
}

function formatTime(value) {
  if (!value) return "-";
  try {
    const d = new Date(value + "Z");
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return value;
  }
}

// Classify user loyalty by session age (lastAccessAt - createdAt)
function getLoyalty(session) {
  const fallback = { tier: LOYALTY_TIERS[LOYALTY_TIERS.length - 1], ageMs: null };
  if (!session?.createdAt || !session?.lastAccessAt) return fallback;
  const ageMs = new Date(session.lastAccessAt + "Z").getTime() - new Date(session.createdAt + "Z").getTime();
  const tier = LOYALTY_TIERS.find((t) => ageMs >= t.minMs) || fallback.tier;
  return { tier, ageMs };
}

// Human-readable duration: "7d 3h" / "2h 15m" / "3m" / "<1m"
function formatDuration(ms) {
  if (ms == null || ms < 0) return "-";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return `${min}m`;
}

function LoyaltyBadge({ session }) {
  const { tier, ageMs } = getLoyalty(session);
  const tierBg =
    tier.key === "loyal"
      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
      : tier.key === "returning"
      ? "bg-brand-500/10 text-brand-500 border-brand-500/20"
      : tier.key === "active"
      ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
      : "bg-surface-2 text-text-muted border-border-subtle";

  return (
    <div className="inline-flex items-center gap-1.5">
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${tierBg}`}>
        {tier.label}
      </span>
      {ageMs != null && (
        <span className="text-text-subtle text-[11px] font-mono">{formatDuration(ageMs)}</span>
      )}
    </div>
  );
}

export default function SessionTable({ items, sortBy, order, onSortChange, onDelete, canDelete }) {
  const handleSort = (key) => {
    if (!SESSION_SORT_FIELDS.includes(key)) return;
    if (sortBy === key) onSortChange(key, order === "asc" ? "desc" : "asc");
    else onSortChange(key, "desc");
  };

  return (
    <>
      {/* Mobile sort selector */}
      <div className="md:hidden flex items-center justify-between mb-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Sort by:</span>
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value, order)}
            className="bg-surface-2 border border-border-subtle rounded-lg px-2.5 py-1.5 text-text focus:outline-none"
          >
            {SORT_OPTIONS.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => onSortChange(sortBy, order === "asc" ? "desc" : "asc")}
          className="flex items-center gap-1 bg-surface-2 hover:bg-surface-3 border border-border-subtle rounded-lg px-2.5 py-1.5 text-text transition-colors"
          aria-label="Toggle order"
        >
          <span className="font-mono uppercase">{order}</span>
          {order === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
        </button>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {items.length === 0 && (
          <div className="card-glass p-8 text-center text-text-muted flex flex-col items-center justify-center">
            <Terminal size={24} className="mb-2 text-text-subtle" />
            <p className="text-sm">No active sessions found</p>
          </div>
        )}
        {items.map((s) => {
          const online = isOnline(s);
          return (
            <div key={s.machineId} className="card-glass overflow-hidden text-sm">
              {/* Card Mini Titlebar */}
              <div className="flex items-center justify-between px-3.5 py-2.5 bg-surface-2/60 border-b border-border-subtle">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="relative flex h-2 w-2">
                    {online ? (
                      <>
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                      </>
                    ) : (
                      <span className="inline-block w-2 h-2 rounded-full bg-neutral-500/40" />
                    )}
                  </span>
                  <span className="font-mono text-xs font-semibold tracking-tight text-text truncate">
                    {s.machineId}
                  </span>
                </div>
                {canDelete && (
                  <button
                    onClick={() => onDelete(s.machineId)}
                    className="text-text-muted hover:text-danger p-1 rounded hover:bg-red-500/10 transition-colors"
                    title="Delete session"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>

              {/* Card Details */}
              <div className="p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Loyalty</span>
                  <LoyaltyBadge session={s} />
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border-subtle/40">
                  <div>
                    <span className="text-[10px] uppercase font-mono text-text-subtle block">Public IP</span>
                    <span className="font-mono text-text truncate block">{s.publicIp || "-"}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-mono text-text-subtle block">Local IP</span>
                    <span className="font-mono text-text truncate block">{s.localIp || "-"}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-border-subtle/40 text-[11px] text-text-muted">
                  <div>
                    <span className="text-text-subtle block">Created</span>
                    <span>{formatTime(s.createdAt)}</span>
                  </div>
                  <div>
                    <span className="text-text-subtle block">Last Access</span>
                    <span className="text-text">{formatTime(s.lastAccessAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block card-glass overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-surface-2/60 border-b border-border-subtle text-[11px] font-mono uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-4 py-3 w-12 text-center">Live</th>
              <th className="px-4 py-3">Loyalty</th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={`px-4 py-3 ${
                    col.sortable ? "cursor-pointer hover:text-text select-none group" : ""
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {col.label}
                    {col.sortable && (
                      <span className={sortBy === col.key ? "text-brand-500" : "text-text-subtle opacity-40 group-hover:opacity-100"}>
                        {sortBy === col.key && order === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                      </span>
                    )}
                  </span>
                </th>
              ))}
              {canDelete && <th className="px-4 py-3 text-right">Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50">
            {items.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 3} className="px-4 py-12 text-center text-text-muted">
                  <Terminal size={28} className="mx-auto mb-2 text-text-subtle" />
                  <p>No active sessions found</p>
                </td>
              </tr>
            )}
            {items.map((s) => {
              const online = isOnline(s);
              return (
                <tr key={s.machineId} className="hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3 text-center">
                    <span className="relative inline-flex h-2 w-2">
                      {online ? (
                        <>
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                        </>
                      ) : (
                        <span className="inline-block w-2 h-2 rounded-full bg-neutral-500/40" />
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <LoyaltyBadge session={s} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-medium text-text">
                    {s.machineId}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {s.publicIp || "-"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">
                    {s.localIp || "-"}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {formatTime(s.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-text font-medium">
                    {formatTime(s.lastAccessAt)}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {formatTime(s.expiresAt)}
                  </td>
                  {canDelete && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => onDelete(s.machineId)}
                        className="text-text-muted hover:text-danger p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                        title="Delete session"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
