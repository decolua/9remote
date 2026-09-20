"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import StatsCards from "@/features/admin/components/StatsCards";
import SessionTable from "@/features/admin/components/SessionTable";
import Pagination from "@/features/admin/components/Pagination";
import LoginActivity from "@/features/admin/components/LoginActivity";
import { Search, RefreshCw } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PAGE_SIZE_DEFAULT, PERMISSIONS } from "@/features/admin/constants";

export default function AdminDashboardPage() {
  const { can } = useAdminAuth();
  const { get, del } = useAdminApi();

  const [stats, setStats] = useState(null);
  const [logins, setLogins] = useState([]);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("lastAccessAt");
  const [order, setOrder] = useState("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, sortBy, order, page: String(page), pageSize: String(pageSize) });
      const requests = [
        get(`${ADMIN_API.sessions}?${params.toString()}`),
        get(ADMIN_API.stats)
      ];
      if (can(PERMISSIONS.logView)) requests.push(get(ADMIN_API.logins));
      const [sessionsData, statsData, loginsData] = await Promise.all(requests);
      setItems(sessionsData.items || []);
      setTotal(sessionsData.total || 0);
      setStats(statsData);
      if (loginsData) setLogins(loginsData.items || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [can, get, search, sortBy, order, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id) => {
    if (!confirm(`Delete session ${id}?`)) return;
    await del(`${ADMIN_API.sessions}/${id}`);
    load();
  };

  const handleSortChange = (key, dir) => { setSortBy(key); setOrder(dir); setPage(1); };

  return (
    <AdminShell>
      <div className="space-y-8">
        {/* Header section */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text login-hero-grad">System Overview</h1>
            <p className="text-xs text-text-muted mt-1">Real-time telemetry and active host instances</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="self-start sm:self-auto inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-border-subtle text-xs font-medium text-text transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin text-brand-500" : ""} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Stats Cards */}
        <section>
          <StatsCards stats={stats} />
        </section>

        {can(PERMISSIONS.logView) && <LoginActivity items={logins} />}

        {/* Sessions Section */}
        <section className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-text">Active Sessions</h2>
              <p className="text-xs text-text-muted">Connected and registered client sessions</p>
            </div>
            <div className="relative w-full sm:w-80">
              <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search machineId, IP address..."
                className="w-full pl-9 pr-3.5 py-2 bg-surface-2/80 border border-border-subtle rounded-xl text-text text-xs placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all font-mono"
              />
            </div>
          </div>

          <SessionTable
            items={items}
            sortBy={sortBy}
            order={order}
            onSortChange={handleSortChange}
            onDelete={handleDelete}
            canDelete={can(PERMISSIONS.sessionDelete)}
          />

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
          />
        </section>
      </div>
    </AdminShell>
  );
}
