"use client";

import { Trash2, ArrowUp, ArrowDown } from "@/shared/components/ui/Icon";
import { SESSION_SORT_FIELDS, SESSION_ONLINE_THRESHOLD_MS, LOYALTY_TIERS } from "../constants";

const COLUMNS = [
  { key: "machineId", label: "Machine ID", sortable: true },
  { key: "shortId", label: "Short ID", sortable: false },
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
  try { return new Date(value + "Z").toLocaleString(); } catch { return value; }
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
  return (
    <div className="flex flex-col">
      <span className={`font-medium ${tier.color}`}>{tier.label}</span>
      <span className="text-text-subtle text-xs">{formatDuration(ageMs)}</span>
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
      <div className="md:hidden flex items-center gap-2 mb-3 text-sm">
        <span className="text-text-muted">Sort:</span>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value, order)}
          className="bg-surface-2 rounded-brand px-2 py-1 text-text"
        >
          {SORT_OPTIONS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <button
          onClick={() => onSortChange(sortBy, order === "asc" ? "desc" : "asc")}
          className="bg-surface-2 hover:bg-surface-3 rounded-brand p-1.5 text-text"
          aria-label="Toggle order"
        >
          {order === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
        </button>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {items.length === 0 && (
          <div className="card-soft p-6 text-center text-text-muted border border-border-subtle">No sessions</div>
        )}
        {items.map((s) => (
          <div key={s.machineId} className="card-soft p-3 border border-border-subtle space-y-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`shrink-0 w-2 h-2 rounded-full ${isOnline(s) ? "bg-success" : "bg-text-subtle"}`}></span>
                <span className="font-mono text-xs truncate">{s.machineId}</span>
              </div>
              {canDelete && (
                <button
                  onClick={() => onDelete(s.machineId)}
                  className="text-text-muted hover:text-danger transition-colors shrink-0"
                  title="Delete"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div className="text-text-muted">Loyalty</div><div><LoyaltyBadge session={s} /></div>
              <div className="text-text-muted">Short ID</div><div>{s.shortId || "-"}</div>
              <div className="text-text-muted">Public IP</div><div>{s.publicIp || "-"}</div>
              <div className="text-text-muted">Local IP</div><div>{s.localIp || "-"}</div>
              <div className="text-text-muted">Last Access</div><div>{formatTime(s.lastAccessAt)}</div>
              <div className="text-text-muted">Created</div><div>{formatTime(s.createdAt)}</div>
              <div className="text-text-muted">Expires</div><div>{formatTime(s.expiresAt)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block card-soft border border-border-subtle overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th className="px-3 py-2 text-left text-text-muted font-medium">Status</th>
              <th className="px-3 py-2 text-left text-text-muted font-medium">Loyalty</th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={`px-3 py-2 text-left text-text-muted font-medium ${col.sortable ? "cursor-pointer hover:text-text select-none" : ""}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && sortBy === col.key && (order === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </span>
                </th>
              ))}
              {canDelete && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={COLUMNS.length + 3} className="px-3 py-8 text-center text-text-muted">No sessions</td></tr>
            )}
            {items.map((s) => (
              <tr key={s.machineId} className="border-t border-border-subtle hover:bg-surface-2/50">
                  <td className="px-3 py-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${isOnline(s) ? "bg-success" : "bg-text-subtle"}`}></span>
                  </td>
                  <td className="px-3 py-2"><LoyaltyBadge session={s} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{s.machineId}</td>
                <td className="px-3 py-2">{s.shortId || "-"}</td>
                <td className="px-3 py-2">{s.publicIp || "-"}</td>
                <td className="px-3 py-2">{s.localIp || "-"}</td>
                <td className="px-3 py-2">{formatTime(s.createdAt)}</td>
                <td className="px-3 py-2">{formatTime(s.lastAccessAt)}</td>
                <td className="px-3 py-2">{formatTime(s.expiresAt)}</td>
                {canDelete && (
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onDelete(s.machineId)}
                      className="text-text-muted hover:text-danger transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
