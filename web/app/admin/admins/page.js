"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { Trash2, Save, Users, Plus, X } from "@/shared/components/ui/Icon";
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
        if (!form.username || !form.password || !form.modeId) { setError("All fields are required"); return; }
        await post(ADMIN_API.admins, form);
      }
      resetForm();
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this admin account?")) return;
    try { await del(`${ADMIN_API.admins}/${id}`); load(); }
    catch (e) { alert(e.message); }
  };

  const formatTime = (v) => {
    if (!v) return "-";
    try {
      return new Date(v + "Z").toLocaleString(undefined, {
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
              <Users size={24} className="text-brand-500" />
              <span>Administrators</span>
            </h1>
            <p className="text-xs text-text-muted mt-1">Manage team operator access and privileged accounts</p>
          </div>
        </div>

        {canManage && (
          <div className="card-glass p-5 sm:p-6 space-y-4 relative overflow-hidden">
            <div className="flex items-center justify-between border-b border-border-subtle/60 pb-3">
              <h2 className="text-sm font-semibold tracking-tight text-text flex items-center gap-2">
                {editingId ? (
                  <>
                    <span className="text-text-muted">Edit admin:</span>
                    <span className="font-mono text-brand-500 font-bold">{form.username}</span>
                  </>
                ) : (
                  <>
                    <Plus size={16} className="text-brand-500" />
                    <span>Create Administrator Account</span>
                  </>
                )}
              </h2>
              {editingId && (
                <button onClick={resetForm} className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                  <X size={14} /> Cancel
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Input
                label="Username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                disabled={!!editingId}
                placeholder="operator username"
              />
              <Input
                label={editingId ? "New Password (optional)" : "Password"}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={editingId ? "Leave blank to keep" : "••••••••"}
              />
              <div>
                <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
                  Assigned Mode
                </label>
                <select
                  value={form.modeId}
                  onChange={(e) => setForm({ ...form, modeId: e.target.value })}
                  className="w-full px-3 py-2.5 bg-surface-2 border border-border-subtle rounded-xl text-text text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 transition-all"
                >
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                  ))}
                </select>
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
                  <span>{editingId ? "Update Account" : "Create Administrator"}</span>
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
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Security Role</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Last Login</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle/50">
              {items.map((a) => {
                const isMe = a.id === me?.id;
                return (
                  <tr key={a.id} className="hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-3.5 font-medium text-text">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{a.username}</span>
                        {isMe && (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-brand-500/10 text-brand-500 border border-brand-500/25">
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 border border-border-subtle text-text">
                        {a.modeName || a.modeId}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-text-muted">{formatTime(a.createdAt)}</td>
                    <td className="px-4 py-3.5 text-xs text-text font-medium">{formatTime(a.lastLoginAt)}</td>
                    {canManage && (
                      <td className="px-4 py-3.5 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => startEdit(a)}
                            className="text-xs text-brand-500 hover:text-brand-400 font-medium px-2 py-1 rounded hover:bg-brand-500/10 transition-colors"
                          >
                            Edit
                          </button>
                          {!isMe && (
                            <button
                              onClick={() => handleDelete(a.id)}
                              className="text-text-muted hover:text-danger p-1 rounded hover:bg-red-500/10 transition-colors"
                              title="Delete admin"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
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
