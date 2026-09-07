"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PERMISSIONS } from "@/features/admin/constants";
import { Package, RefreshCw, CheckCircle2, ArrowUpRight } from "@/shared/components/ui/Icon";

const PLATFORMS = ["", "ios", "android"];

export default function OtaPage() {
  const { can } = useAdminAuth();
  const { get, post } = useAdminApi();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ runtimeVersion: "", platform: "", channel: "" });
  const [promotingId, setPromotingId] = useState(null);

  const canManage = can(PERMISSIONS.otaManage);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filters.runtimeVersion) params.set("runtimeVersion", filters.runtimeVersion);
      if (filters.platform) params.set("platform", filters.platform);
      if (filters.channel) params.set("channel", filters.channel);
      const data = await get(`${ADMIN_API.ota}?${params}`);
      setItems(data.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [get, filters.runtimeVersion, filters.platform, filters.channel]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const handlePromote = async (item) => {
    if (!confirm(`Promote #${item.buildNumber} to serving for channel "${item.channel}" (${item.platform}, ${item.runtimeVersion})?`)) return;
    setPromotingId(item.id);
    try {
      await post(`${ADMIN_API.ota}/${item.id}/promote`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPromotingId(null);
    }
  };

  const formatTime = (v) => {
    if (!v) return "-";
    try {
      return new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return v;
    }
  };

  return (
    <AdminShell>
      <div className="space-y-8 max-w-5xl">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text login-hero-grad flex items-center gap-2.5">
              <Package size={24} className="text-brand-500" />
              <span>OTA Updates</span>
            </h1>
            <p className="text-xs text-text-muted mt-1">Publish, promote and rollback mobile application bundles</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-border-subtle text-xs font-medium text-text transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin text-brand-500" : ""} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Filter bar */}
        <div className="card-glass p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            className="px-3 py-2 text-xs border border-border-subtle rounded-xl bg-surface-2/80 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-500/30 font-mono"
            placeholder="Runtime (e.g. 0.1.7)"
            value={filters.runtimeVersion}
            onChange={(e) => setFilters({ ...filters, runtimeVersion: e.target.value })}
          />
          <select
            className="px-3 py-2 text-xs border border-border-subtle rounded-xl bg-surface-2/80 text-text focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            value={filters.platform}
            onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>{p ? p.toUpperCase() : "All platforms"}</option>
            ))}
          </select>
          <input
            className="px-3 py-2 text-xs border border-border-subtle rounded-xl bg-surface-2/80 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-500/30 font-mono"
            placeholder="Channel (e.g. production)"
            value={filters.channel}
            onChange={(e) => setFilters({ ...filters, channel: e.target.value })}
          />
          <button
            onClick={load}
            className="px-4 py-2 text-xs font-semibold bg-brand-500 text-white rounded-xl hover:bg-brand-600 shadow-[0_4px_12px_-4px_rgba(255,87,10,0.5)] transition-all"
          >
            Filter Bundles
          </button>
        </div>

        {error && (
          <p className="text-xs text-danger bg-red-500/10 p-3 rounded-xl border border-red-500/20">
            {error}
          </p>
        )}

        {loading ? (
          <div className="card-glass p-12 text-center text-text-muted text-xs">
            <RefreshCw size={20} className="mx-auto mb-2 animate-spin text-brand-500" />
            Loading updates catalog...
          </div>
        ) : items.length === 0 ? (
          <div className="card-glass p-12 text-center">
            <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center mx-auto mb-3 text-text-subtle">
              <Package size={24} />
            </div>
            <h3 className="text-sm font-semibold text-text">No updates published</h3>
            <p className="text-text-muted text-xs mt-1">
              Publish an OTA update package with <code className="text-brand-500 font-mono px-1.5 py-0.5 rounded bg-surface-2">npm run update</code>
            </p>
          </div>
        ) : (
          <div className="card-glass overflow-hidden">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2/60 border-b border-border-subtle text-[11px] font-mono uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Build</th>
                  <th className="px-4 py-3">Runtime</th>
                  <th className="px-4 py-3">Platform</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Published</th>
                  <th className="px-4 py-3">Status</th>
                  {canManage && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle/50">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-3.5">
                      <div className="font-medium text-text">
                        <span className="text-brand-500 font-mono font-bold mr-2">#{item.buildNumber}</span>
                        <span>{item.message || "(no message)"}</span>
                      </div>
                      <div className="text-[10px] text-text-subtle font-mono mt-0.5">{item.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-3.5 text-xs font-mono text-text-muted">{item.runtimeVersion}</td>
                    <td className="px-4 py-3.5">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase tracking-wider border ${
                        item.platform === "ios"
                          ? "bg-sky-500/10 text-sky-500 border-sky-500/20"
                          : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                      }`}>
                        {item.platform}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-surface-2 border border-border-subtle text-text">
                        {item.channel}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-text-muted font-mono">
                      {formatTime(item.publishedAt || item.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">
                      {item.isServing ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                          <CheckCircle2 size={13} />
                          <span>Serving</span>
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-text-subtle px-2 py-0.5 rounded bg-surface-2">
                          {item.status}
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3.5 text-right">
                        {!item.isServing && (
                          <button
                            onClick={() => handlePromote(item)}
                            disabled={promotingId === item.id}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-500 hover:text-brand-400 px-2.5 py-1 rounded-lg hover:bg-brand-500/10 transition-colors disabled:opacity-50"
                          >
                            <span>{promotingId === item.id ? "Promoting..." : "Promote"}</span>
                            <ArrowUpRight size={13} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
