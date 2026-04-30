"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { Plus, Trash2, Save } from "@/shared/components/ui/Icon";
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
    try { perms = JSON.parse(m.permissions); } catch { perms = []; }
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
        if (!form.id || !form.name) { setError("id and name required"); return; }
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
      <div className="space-y-6 max-w-4xl">
        <h2 className="text-2xl font-bold">Modes</h2>

        {canManage && (
          <div className="card-soft p-4 border border-border-subtle space-y-3">
            <h3 className="font-semibold">{editingId ? `Edit: ${editingId}` : "Create new mode"}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="ID"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                disabled={!!editingId}
                placeholder="e.g. editor"
              />
              <Input
                label="Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Display name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-2">Permissions</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {PERMISSION_LIST.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.permissions.includes(p)}
                      onChange={() => togglePerm(p)}
                      className="w-4 h-4 accent-brand-500"
                    />
                    <span className="text-text">{p}</span>
                  </label>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button variant="primary" onClick={handleSave}>
                <span className="inline-flex items-center gap-2"><Save size={16} />{editingId ? "Update" : "Create"}</span>
              </Button>
              {editingId && <Button variant="secondary" onClick={resetForm}>Cancel</Button>}
            </div>
          </div>
        )}

        <div className="card-soft border border-border-subtle overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-2">
              <tr>
                <th className="px-3 py-2 text-left text-text-muted font-medium">ID</th>
                <th className="px-3 py-2 text-left text-text-muted font-medium">Name</th>
                <th className="px-3 py-2 text-left text-text-muted font-medium">Permissions</th>
                {canManage && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                  <td className="px-3 py-2 font-mono text-xs">{m.id}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2 text-xs text-text-muted">{m.permissions}</td>
                  {canManage && (
                    <td className="px-3 py-2 flex gap-2 justify-end">
                      <button onClick={() => startEdit(m)} className="text-brand-500 hover:text-brand-400 text-sm">Edit</button>
                      <button onClick={() => handleDelete(m.id)} className="text-text-muted hover:text-danger"><Trash2 size={16} /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
