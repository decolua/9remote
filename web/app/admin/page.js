"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import StatsCards from "@/features/admin/components/StatsCards";
import SessionTable from "@/features/admin/components/SessionTable";
import Pagination from "@/features/admin/components/Pagination";
import { Search } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PAGE_SIZE_DEFAULT, PERMISSIONS } from "@/features/admin/constants";

export default function AdminDashboardPage() {
  const { can } = useAdminAuth();
  const { get, del } = useAdminApi();

  const [stats, setStats] = useState(null);
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
      const [sessionsData, statsData] = await Promise.all([
        get(`${ADMIN_API.sessions}?${params.toString()}`),
        get(ADMIN_API.stats)
      ]);
      setItems(sessionsData.items || []);
      setTotal(sessionsData.total || 0);
      setStats(statsData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [get, search, sortBy, order, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id) => {
    if (!confirm(`Delete session ${id}?`)) return;
    await del(`${ADMIN_API.sessions}/${id}`);
    load();
  };

  const handleSortChange = (key, dir) => { setSortBy(key); setOrder(dir); setPage(1); };

  return (
    <AdminShell>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold mb-4">Dashboard</h2>
          <StatsCards stats={stats} />
        </div>

        <div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
            <h3 className="text-lg font-semibold">Sessions</h3>
            <div className="relative w-full sm:w-72">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search machineId, IP..."
                className="w-full pl-9 pr-3 py-2 bg-surface-2 rounded-brand text-text text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
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
          {loading && <div className="text-xs text-text-muted mt-2">Loading...</div>}
        </div>
      </div>
    </AdminShell>
  );
}
