"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import LoginActivity from "@/features/admin/components/LoginActivity";
import { Trash2, Save, Plus, X, Check } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import {
  ADMIN_API, PERMISSIONS, PERMISSION_GROUPS, PERMISSION_META
} from "@/features/admin/constants";

const EMPTY_ADMIN_FORM = { username: "", password: "", modeId: "" };
const EMPTY_MODE_FORM = { id: "", name: "", permissions: [] };

function parsePerms(m) {
  try { return typeof m.permissions === "string" ? JSON.parse(m.permissions) : m.permissions; } catch { return []; }
}

function formatTime(v) {
  if (!v) return "-";
  try {
    return new Date(v + "Z").toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return v;
  }
}

export default function AccessPage() {
  const { me, can, loading: authLoading } = useAdminAuth();
  const { get, post, patch, del } = useAdminApi();

  const [admins, setAdmins] = useState([]);
  const [modes, setModes] = useState([]);
  const [logins, setLogins] = useState([]);
  const [adminForm, setAdminForm] = useState(EMPTY_ADMIN_FORM);
  const [editingAdminId, setEditingAdminId] = useState(null);
  const [modeForm, setModeForm] = useState(EMPTY_MODE_FORM);
  const [editingModeId, setEditingModeId] = useState(null);
  const [error, setError] = useState("");

  const canAdmins = can(PERMISSIONS.adminManage);
  const canModes = can(PERMISSIONS.modeManage);
  const canLog = can(PERMISSIONS.logView);

  const tabs = [
    { key: "admins", label: "Admins" },
    { key: "modes", label: "Modes & Permissions" },
    ...(canLog ? [{ key: "logins", label: "Login Activity" }] : [])
  ];
  const [tab, setTab] = useState("admins");

  const load = useCallback(async () => {
    const requests = [get(ADMIN_API.admins), get(ADMIN_API.modes)];
    if (can(PERMISSIONS.logView)) requests.push(get(ADMIN_API.logins));
    const [a, m, l] = await Promise.all(requests);
    setAdmins(a.items || []);
    setModes(m.items || []);
    if (l) setLogins(l.items || []);
    setAdminForm((f) => ({ ...f, modeId: f.modeId || (m.items || [])[0]?.id || "" }));
  }, [can, get]);

  useEffect(() => { if (!authLoading && me) load(); }, [authLoading, me, load]);

  const resetAdminForm = () => {
    setEditingAdminId(null);
    setAdminForm({ ...EMPTY_ADMIN_FORM, modeId: modes[0]?.id || "" });
    setError("");
  };

  const handleSaveAdmin = async () => {
    setError("");
    try {
      if (editingAdminId) {
        await patch(`${ADMIN_API.admins}/${editingAdminId}`, {
          modeId: adminForm.modeId,
          ...(adminForm.password ? { password: adminForm.password } : {})
        });
      } else {
        if (!adminForm.username || !adminForm.password || !adminForm.modeId) { setError("All fields are required"); return; }
        await post(ADMIN_API.admins, adminForm);
      }
      resetAdminForm();
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDeleteAdmin = async (id) => {
    if (!confirm("Delete this admin account?")) return;
    try { await del(`${ADMIN_API.admins}/${id}`); load(); }
    catch (e) { alert(e.message); }
  };

  const togglePerm = (perm) => {
    setModeForm((f) => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter((p) => p !== perm)
        : [...f.permissions, perm]
    }));
  };

  const resetModeForm = () => { setEditingModeId(null); setModeForm(EMPTY_MODE_FORM); setError(""); };

  const handleSaveMode = async () => {
    setError("");
    try {
      if (editingModeId) {
        await patch(`${ADMIN_API.modes}/${editingModeId}`, { name: modeForm.name, permissions: modeForm.permissions });
      } else {
        if (!modeForm.id || !modeForm.name) { setError("ID and name are required"); return; }
        await post(ADMIN_API.modes, modeForm);
      }
      resetModeForm();
      load();
    } catch (e) { setError(e.message); }
  };

  const handleDeleteMode = async (id) => {
    if (!confirm(`Delete mode ${id}?`)) return;
    try { await del(`${ADMIN_API.modes}/${id}`); load(); }
    catch (e) { alert(e.message); }
  };

  const adminsSection = (
    <section className="space-y-4">
      {canAdmins && (
        <div className="card-glass p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-border-subtle/60 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-text flex items-center gap-2">
              {editingAdminId ? (
                <>
                  <span className="text-text-muted">Edit admin:</span>
                  <span className="font-mono text-brand-500 font-bold">{adminForm.username}</span>
                </>
              ) : (
                <>
                  <Plus size={16} className="text-brand-500" />
                  <span>Create Administrator Account</span>
                </>
              )}
            </h2>
            {editingAdminId && (
              <button onClick={resetAdminForm} className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                <X size={14} /> Cancel
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Username"
              value={adminForm.username}
              onChange={(e) => setAdminForm({ ...adminForm, username: e.target.value })}
              disabled={!!editingAdminId}
              placeholder="operator username"
            />
            <Input
              label={editingAdminId ? "New Password (optional)" : "Password"}
              type="password"
              value={adminForm.password}
              onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
              placeholder={editingAdminId ? "Leave blank to keep" : "••••••••"}
            />
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-2">
                Assigned Mode
              </label>
              <select
                value={adminForm.modeId}
                onChange={(e) => setAdminForm({ ...adminForm, modeId: e.target.value })}
                className="w-full px-3 py-2.5 bg-surface-2 border border-border-subtle rounded-xl text-text text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 transition-all"
              >
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                ))}
              </select>
            </div>
          </div>

          {error && editingAdminId !== null && (
            <p className="text-xs text-danger bg-red-500/10 p-2.5 rounded-lg border border-red-500/20">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="primary" onClick={handleSaveAdmin} className="rounded-xl px-4 py-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                <Save size={14} />
                <span>{editingAdminId ? "Update Account" : "Create Administrator"}</span>
              </span>
            </Button>
            {editingAdminId && (
              <Button variant="secondary" onClick={resetAdminForm} className="rounded-xl px-4 py-2 text-xs">
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
              {canAdmins && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50">
            {admins.map((a) => {
              const isMe = a.id === me?.id;
              return (
                <tr key={a.id} className="hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3.5 font-medium text-text">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{a.username}</span>
                      {isMe && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-500 border border-brand-500/25">
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
                  {canAdmins && (
                    <td className="px-4 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => { setEditingAdminId(a.id); setAdminForm({ username: a.username, password: "", modeId: a.modeId }); setError(""); }}
                          className="text-xs text-brand-500 hover:text-brand-400 font-medium px-2 py-1 rounded hover:bg-brand-500/10 transition-colors"
                        >
                          Edit
                        </button>
                        {!isMe && (
                          <button
                            onClick={() => handleDeleteAdmin(a.id)}
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
    </section>
  );

  const modesSection = (
    <section className="space-y-4">
      {canModes && (
        <div className="card-glass p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-border-subtle/60 pb-3">
            <h2 className="text-sm font-semibold tracking-tight text-text flex items-center gap-2">
              {editingModeId ? (
                <>
                  <span className="text-text-muted">Edit role:</span>
                  <span className="font-mono text-brand-500 font-bold">{editingModeId}</span>
                </>
              ) : (
                <>
                  <Plus size={16} className="text-brand-500" />
                  <span>Create New Security Mode</span>
                </>
              )}
            </h2>
            {editingModeId && (
              <button onClick={resetModeForm} className="text-xs text-text-muted hover:text-text flex items-center gap-1">
                <X size={14} /> Cancel
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Mode ID"
              value={modeForm.id}
              onChange={(e) => setModeForm({ ...modeForm, id: e.target.value })}
              disabled={!!editingModeId}
              placeholder="e.g. support-lead"
            />
            <Input
              label="Display Name"
              value={modeForm.name}
              onChange={(e) => setModeForm({ ...modeForm, name: e.target.value })}
              placeholder="e.g. Support Team Lead"
            />
          </div>

          <div className="space-y-3">
            {PERMISSION_GROUPS.map((g) => (
              <div key={g.label}>
                <div className="text-[10px] font-mono uppercase tracking-wider text-text-subtle mb-1.5">{g.label}</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {g.keys.map((p) => {
                    const selected = modeForm.permissions.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => togglePerm(p)}
                        title={p}
                        className={`flex items-center justify-between px-3 py-2 rounded-[6px] text-xs border transition-colors text-left ${
                          selected
                            ? "bg-brand-500/12 text-brand-500 border-brand-500/30"
                            : "bg-surface-2/60 text-text-muted border-border-subtle hover:bg-surface-2 hover:text-text"
                        }`}
                      >
                        <span className="truncate">{PERMISSION_META[p] || p}</span>
                        {selected ? <Check size={13} className="text-brand-500 shrink-0 ml-1.5" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {error && editingModeId === null && (
            <p className="text-xs text-danger bg-red-500/10 p-2.5 rounded-lg border border-red-500/20">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="primary" onClick={handleSaveMode} className="rounded-xl px-4 py-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                <Save size={14} />
                <span>{editingModeId ? "Save Changes" : "Create Mode"}</span>
              </span>
            </Button>
            {editingModeId && (
              <Button variant="secondary" onClick={resetModeForm} className="rounded-xl px-4 py-2 text-xs">
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
              {canModes && <th className="px-4 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50">
            {modes.map((m) => {
              const perms = parsePerms(m);
              return (
                <tr key={m.id} className="hover:bg-surface-2/40 transition-colors">
                  <td className="px-4 py-3.5 font-mono text-xs font-semibold text-text">{m.id}</td>
                  <td className="px-4 py-3.5 font-medium text-text">
                    {m.name}
                    <span className="block text-[11px] text-text-muted font-normal">{perms.length} permissions</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex flex-wrap gap-1 max-w-md">
                      {perms.map((p) => (
                        <span
                          key={p}
                          title={p}
                          className="px-2 py-0.5 rounded-[4px] bg-surface-2 border border-border-subtle text-[11px] text-text-muted"
                        >
                          {PERMISSION_META[p] || p}
                        </span>
                      ))}
                    </div>
                  </td>
                  {canModes && (
                    <td className="px-4 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => {
                            setEditingModeId(m.id);
                            setModeForm({ id: m.id, name: m.name, permissions: perms });
                            setError("");
                          }}
                          className="text-xs text-brand-500 hover:text-brand-400 font-medium px-2 py-1 rounded hover:bg-brand-500/10 transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteMode(m.id)}
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
    </section>
  );

  return (
    <AdminShell>
      <div className="space-y-6 max-w-5xl">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-text">Access Control</h1>
          <p className="text-xs text-text-muted mt-1">Operator accounts, security roles and login audit</p>
        </div>

        {/* Sub-tabs — workspace term-tab look */}
        <div className="flex items-stretch border-b border-border-subtle overflow-x-auto scrollbar-none -mb-px">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`term-tab flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap cursor-pointer ${tab === t.key ? "term-tab-active" : ""}`}
            >
              {tab === t.key && <span className="w-1 h-1 rounded-full bg-text-muted" />}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {tab === "admins" && adminsSection}
        {tab === "modes" && modesSection}
        {tab === "logins" && canLog && <LoginActivity items={logins} />}
      </div>
    </AdminShell>
  );
}
