"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { Trash2, Save } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PERMISSIONS } from "@/features/admin/constants";

const EMPTY_FORM = { username: "", password: "", modeId: "" };

export default function AdminsPage() {
  const { me, can } = useAdminAuth();
  const { get, post, patch, del } = useAdminApi();
  const [items, setItems] = useState([]);
  const [modes, setModes] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");

  const canManage = can(PERMISSIONS.adminManage);

  const load = useCallback(async () => {
    const [a, m] = await Promise.all([get(ADMIN_API.admins), get(ADMIN_API.modes)]);
    setItems(a.items || []);
    setModes(m.items || []);
    if (!form.modeId && (m.items || []).length > 0) {
      setForm((f) => ({ ...f, modeId: m.items[0].id }));
    }
  }, [get]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (a) => {
    setEditingId(a.id);
    setForm({ username: a.username, password: "", modeId: a.modeId });
  };

  const resetForm = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, modeId: modes[0]?.id || "" });
    setError("");
  };

  const handleSave = async () => {
    setError("");
    try {
      if (editingId) {
        await patch(`${ADMIN_API.admins}/${editingId}`, {
          modeId: form.modeId,
          ...(form.password ? { password: form.password } : {})
        });
      } else {
        if (!form.username || !form.password || !form.modeId) { setError("All fields required"); return; }
        await post(ADMIN_API.admins, form);
      }
      resetForm();
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this admin?")) return;
    try { await del(`${ADMIN_API.admins}/${id}`); load(); }
    catch (e) { alert(e.message); }
  };

  const formatTime = (v) => v ? new Date(v + "Z").toLocaleString() : "-";

  return (
    <AdminShell>
      <div className="space-y-6 max-w-4xl">
        <h2 className="text-2xl font-bold">Admins</h2>

        {canManage && (
          <div className="card-soft p-4 border border-border-subtle space-y-3">
            <h3 className="font-semibold">{editingId ? `Edit: ${form.username}` : "Create new admin"}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Input
                label="Username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                disabled={!!editingId}
              />
              <Input
                label={editingId ? "New password (optional)" : "Password"}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-text mb-2">Mode</label>
                <select
                  value={form.modeId}
                  onChange={(e) => setForm({ ...form, modeId: e.target.value })}
                  className="w-full px-3 py-3 bg-surface-2 rounded-brand text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
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
                <th className="px-3 py-2 text-left text-text-muted font-medium">Username</th>
                <th className="px-3 py-2 text-left text-text-muted font-medium">Mode</th>
                <th className="px-3 py-2 text-left text-text-muted font-medium">Created</th>
                <th className="px-3 py-2 text-left text-text-muted font-medium">Last Login</th>
                {canManage && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-t border-border-subtle hover:bg-surface-2/50">
                  <td className="px-3 py-2 font-medium">{a.username}{a.id === me?.id && <span className="ml-2 text-xs text-brand-500">(you)</span>}</td>
                  <td className="px-3 py-2">{a.modeName || a.modeId}</td>
                  <td className="px-3 py-2">{formatTime(a.createdAt)}</td>
                  <td className="px-3 py-2">{formatTime(a.lastLoginAt)}</td>
                  {canManage && (
                    <td className="px-3 py-2 flex gap-2 justify-end">
                      <button onClick={() => startEdit(a)} className="text-brand-500 hover:text-brand-400 text-sm">Edit</button>
                      {a.id !== me?.id && (
                        <button onClick={() => handleDelete(a.id)} className="text-text-muted hover:text-danger"><Trash2 size={16} /></button>
                      )}
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
