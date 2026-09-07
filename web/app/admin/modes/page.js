"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { Plus, Trash2, Save, Shield, Check, X } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PERMISSIONS, PERMISSION_LIST } from "@/features/admin/constants";

const EMPTY_FORM = { id: "", name: "", permissions: [] };

export default function ModesPage() {
  const { can } = useAdminAuth();
  const { get, post, patch, del } = useAdminApi();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");

  const canManage = can(PERMISSIONS.modeManage);

  const load = useCallback(async () => {
    const data = await get(ADMIN_API.modes);
    setItems(data.items || []);
  }, [get]);

  useEffect(() => { load(); }, [load]);

  const togglePerm = (perm) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter((p) => p !== perm)
        : [...f.permissions, perm]
    }));
  };

  const startEdit = (m) => {
    let perms = [];
    try { perms = typeof m.permissions === "string" ? JSON.parse(m.permissions) : m.permissions; } catch { perms = []; }
    setEditingId(m.id);
    setForm({ id: m.id, name: m.name, permissions: perms });
  };

  const resetForm = () => { setEditingId(null); setForm(EMPTY_FORM); setError(""); };

  const handleSave = async () => {
    setError("");
    try {
      if (editingId) {
        await patch(`${ADMIN_API.modes}/${editingId}`, { name: form.name, permissions: form.permissions });
      } else {
        if (!form.id || !form.name) { setError("ID and name are required"); return; }
        await post(ADMIN_API.modes, form);
      }
      resetForm();
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDelete = async (id) => {
    if (!confirm(`Delete mode ${id}?`)) return;
    try { await del(`${ADMIN_API.modes}/${id}`); load(); }
    catch (e) { alert(e.message); }
  };

  return (
    <AdminShell>
      <div className="space-y-8 max-w-5xl">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text login-hero-grad flex items-center gap-2.5">
              <Shield size={24} className="text-brand-500" />
              <span>Modes & Permissions</span>
            </h1>
            <p className="text-xs text-text-muted mt-1">Configure security roles and granular permission sets</p>
          </div>
        </div>

        {canManage && (
          <div className="card-glass p-5 sm:p-6 space-y-4 relative overflow-hidden">
            <div className="flex items-center justify-between border-b border-border-subtle/60 pb-3">
              <h2 className="text-sm font-semibold tracking-tight text-text flex items-center gap-2">
                {editingId ? (
                  <>
                    <span className="text-text-muted">Edit role:</span>
                    <span className="font-mono text-brand-500 font-bold">{editingId}</span>
                  </>
                ) : (
                  <>
                    <Plus size={16} className="text-brand-500" />
                    <span>Create New Security Mode</span>
                  </>
                )}
              </h2>
              {editingId && (
                <button onClick={resetForm} className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                  <X size={14} /> Cancel
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Mode ID"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                disabled={!!editingId}
                placeholder="e.g. support-lead"
              />
              <Input
                label="Display Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Support Team Lead"
              />
            </div>

            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-2.5">
                Permissions Granted
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PERMISSION_LIST.map((p) => {
                  const selected = form.permissions.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePerm(p)}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-mono border transition-all text-left ${
                        selected
                          ? "bg-brand-500/12 text-brand-500 border-brand-500/30 shadow-[0_2px_8px_-2px_rgba(255,87,10,0.2)]"
                          : "bg-surface-2/60 text-text-muted border-border-subtle hover:bg-surface-2 hover:text-text"
                      }`}
                    >
                      <span className="truncate">{p}</span>
                      {selected ? <Check size={13} className="text-brand-500 shrink-0 ml-1.5" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {error && (
              <p className="text-xs text-danger bg-red-500/10 p-2.5 rounded-lg border border-red-500/20">
                {error}
              </p>
            )}

            <div className="flex gap-2 pt-2">
              <Button variant="primary" onClick={handleSave} className="rounded-xl px-4 py-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                  <Save size={14} />
                  <span>{editingId ? "Save Changes" : "Create Mode"}</span>
                </span>
              </Button>
              {editingId && (
                <Button variant="secondary" onClick={resetForm} className="rounded-xl px-4 py-2 text-xs">
                  Cancel
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="card-glass overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-surface-2/60 border-b border-border-subtle text-[11px] font-mono uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Role Name</th>
                <th className="px-4 py-3">Assigned Permissions</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/50">
              {items.map((m) => {
                let perms = [];
                try { perms = typeof m.permissions === "string" ? JSON.parse(m.permissions) : m.permissions; } catch { perms = []; }
                return (
                  <tr key={m.id} className="hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-3.5 font-mono text-xs font-semibold text-text">{m.id}</td>
                    <td className="px-4 py-3.5 font-medium text-text">{m.name}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {perms.map((p) => (
                          <span key={p} className="px-2 py-0.5 rounded-md bg-surface-2 border border-border-subtle text-[10px] font-mono text-text-muted">
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    {canManage && (
                      <td className="px-4 py-3.5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => startEdit(m)}
                            className="text-xs text-brand-500 hover:text-brand-400 font-medium px-2 py-1 rounded hover:bg-brand-500/10 transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(m.id)}
                            className="text-text-muted hover:text-danger p-1 rounded hover:bg-red-500/10 transition-colors"
                            title="Delete mode"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
