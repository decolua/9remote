"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PERMISSIONS } from "@/features/admin/constants";
import { Package, RefreshCw, CheckCircle2 } from "@/shared/components/ui/Icon";

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

  return (
    <AdminShell>
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <Package size={22} /> OTA Updates
            </h2>
            <p className="text-sm text-text-muted mt-1">Publish, promote, rollback app updates</p>
          </div>
          <button onClick={load} className="text-text-muted hover:text-text flex items-center gap-1.5 text-sm">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        <div className="card-soft p-4 border border-border-subtle grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input
            className="px-3 py-2 text-sm border border-border rounded-brand bg-surface text-text"
            placeholder="Runtime (e.g. 0.1.7)"
            value={filters.runtimeVersion}
            onChange={(e) => setFilters({ ...filters, runtimeVersion: e.target.value })}
          />
          <select
            className="px-3 py-2 text-sm border border-border rounded-brand bg-surface text-text"
            value={filters.platform}
            onChange={(e) => setFilters({ ...filters, platform: e.target.value })}
          >
            {PLATFORMS.map((p) => <option key={p} value={p}>{p || "All platforms"}</option>)}
          </select>
          <input
            className="px-3 py-2 text-sm border border-border rounded-brand bg-surface text-text"
            placeholder="Channel (e.g. production)"
            value={filters.channel}
            onChange={(e) => setFilters({ ...filters, channel: e.target.value })}
          />
          <button onClick={load} className="px-3 py-2 text-sm bg-brand-500 text-white rounded-brand hover:bg-brand-600">
            Filter
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        {loading ? (
          <p className="text-sm text-text-muted">Loading...</p>
        ) : items.length === 0 ? (
          <div className="card-soft border border-border-subtle p-8 text-center">
            <Package size={32} className="mx-auto text-text-muted mb-2" />
            <p className="text-text-muted text-sm">No updates yet. Publish one via <code className="text-brand-500">npm run update</code>.</p>
          </div>
        ) : (
          <div className="card-soft border border-border-subtle overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Build</th>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Runtime</th>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Platform</th>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Channel</th>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Published</th>
                  <th className="px-4 py-2.5 text-left text-text-muted font-medium">Status</th>
                  {canManage && <th className="px-4 py-2.5"></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">
                        <span className="text-brand-500 font-mono mr-1.5">#{item.buildNumber}</span>
                        {item.message || "(no message)"}
                      </div>
                      <div className="text-xs text-text-subtle font-mono">{item.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{item.runtimeVersion}</td>
                    <td className="px-4 py-2.5 text-text-muted uppercase">{item.platform}</td>
                    <td className="px-4 py-2.5 text-text-muted">{item.channel}</td>
                    <td className="px-4 py-2.5 text-text-subtle">
                      {new Date(item.publishedAt || item.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      {item.isServing
                        ? <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><CheckCircle2 size={12} /> Serving</span>
                        : <span className="text-xs text-text-subtle">{item.status}</span>}
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5 text-right">
                        {!item.isServing && (
                          <button
                            onClick={() => handlePromote(item)}
                            disabled={promotingId === item.id}
                            className="text-brand-500 hover:text-brand-400 text-sm disabled:opacity-50"
                          >
                            {promotingId === item.id ? "..." : "Promote"}
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
