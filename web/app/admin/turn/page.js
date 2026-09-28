"use client";

import { useCallback, useEffect, useState } from "react";
import AdminShell from "@/features/admin/components/AdminShell";
import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { Plus, Trash2, KeyRound, RefreshCw, Check, X, Copy, ExternalLink } from "@/shared/components/ui/Icon";
import { useAdminApi } from "@/features/admin/hooks/useAdminApi";
import { useAdminAuth } from "@/features/admin/hooks/useAdminAuth";
import { ADMIN_API, PERMISSIONS } from "@/features/admin/constants";
import { TURN_DASHBOARD_URL } from "@/features/admin/lib/turnKeys";

const EMPTY_FORM = { keyId: "", secret: "", label: "", scope: "both" };
const SCOPES = ["both", "dev", "prod"];

// Free allowance is per Cloudflare account, not per key — extra keys rotate
// usage and separate environments, they do not raise the quota.
const HINT = "Up to 1,000 keys. 1,000 GB/month free per Cloudflare account (shared with SFU) — more keys do not add quota.";

export default function TurnKeysPage() {
  const { can, me, loading: authLoading } = useAdminAuth();
  const { get, post, patch, del } = useAdminApi();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdSecret, setCreatedSecret] = useState(null);

  const canManage = can(PERMISSIONS.turnManage);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get(ADMIN_API.turn);
      setItems(data.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => { if (!authLoading && me) load(); }, [authLoading, me, load]);

  const handleAdd = async () => {
    setError("");
    setBusy(true);
    setCreatedSecret(null); // a stale reveal would outlive the failed attempt
    try {
      await post(ADMIN_API.turn, form);
      // Clear the form and its revealed secret together — showing the old value
      // after a failed second attempt would label the wrong key.
      setCreatedSecret(form.secret);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (item) => {
    try { await patch(`${ADMIN_API.turn}/${item.id}`, { enabled: !item.enabled }); load(); }
    catch (e) { setError(e.message); }
  };

  const handleScope = async (item, scope) => {
    try { await patch(`${ADMIN_API.turn}/${item.id}`, { scope }); load(); }
    catch (e) { setError(e.message); }
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this TURN key? Clients using it fall back to STUN-only.")) return;
    try { await del(`${ADMIN_API.turn}/${id}`); load(); }
    catch (e) { setError(e.message); }
  };

  const formatTime = (v) => {
    if (!v) return "never";
    try { return new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return v; }
  };

  return (
    <AdminShell>
      <div className="space-y-8 max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text login-hero-grad flex items-center gap-2.5">
              <KeyRound size={24} className="text-brand-500" />
              <span>TURN Keys</span>
            </h1>
            <p className="text-xs text-text-muted mt-1">Rotate Cloudflare TURN credentials for cross-network WebRTC relay</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={TURN_DASHBOARD_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold transition-colors shadow-[0_4px_12px_-4px_rgba(255,87,10,0.5)]"
            >
              <ExternalLink size={13} />
              <span>Create on Cloudflare</span>
            </a>
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-surface-2 hover:bg-surface-3 border border-border-subtle text-xs font-medium text-text transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin text-brand-500" : ""} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <p className="text-xs text-text-muted bg-surface-2/60 border border-border-subtle rounded-xl p-3">
          {HINT}
        </p>

        {error && (
          <p className="text-xs text-danger bg-red-500/10 p-3 rounded-xl border border-red-500/20">{error}</p>
        )}

        {createdSecret && (
          <div className="card-glass p-4 space-y-2 border border-brand-500/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text">Key added — secret stored. Copy it if you need it elsewhere:</span>
              <button onClick={() => setCreatedSecret(null)} className="text-text-muted hover:text-text"><X size={14} /></button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] font-mono text-text-muted bg-surface-2 rounded-lg px-3 py-2 break-all">{createdSecret}</code>
              <button
                onClick={() => navigator.clipboard?.writeText(createdSecret)}
                className="p-2 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text transition-colors"
                aria-label="Copy secret"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
        )}

        {canManage && (
          <div className="card-glass p-5 sm:p-6 space-y-4">
            <h2 className="text-sm font-semibold tracking-tight text-text flex items-center gap-2 border-b border-border-subtle/60 pb-3">
              <Plus size={16} className="text-brand-500" />
              <span>Add TURN Key</span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Key ID"
                value={form.keyId}
                onChange={(e) => setForm({ ...form, keyId: e.target.value.trim() })}
                placeholder="32-char hex from Cloudflare dashboard"
              />
              <Input
                label="API Token / Secret"
                type="password"
                value={form.secret}
                onChange={(e) => setForm({ ...form, secret: e.target.value.trim() })}
                placeholder="Bearer secret"
              />
              <Input
                label="Label"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="e.g. acc-1 (which Cloudflare account)"
              />
              <div>
                <label className="block text-xs font-mono uppercase tracking-wider text-text-muted mb-1.5">Scope</label>
                <select
                  className="w-full px-3 py-2 text-xs border border-border-subtle rounded-xl bg-surface-2/80 text-text focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  value={form.scope}
                  onChange={(e) => setForm({ ...form, scope: e.target.value })}
                >
                  {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={handleAdd} disabled={busy || !form.keyId || !form.secret}>
                {busy ? "Validating with Cloudflare..." : "Add Key"}
              </Button>
              <span className="text-xs text-text-muted">
                Scope <span className="font-mono">dev</span> = credentials for pages on dev.9remote.cc only.
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="card-glass p-12 text-center text-text-muted text-xs">
            <RefreshCw size={20} className="mx-auto mb-2 animate-spin text-brand-500" />
            Loading keys...
          </div>
        ) : items.length === 0 ? (
          <div className="card-glass p-12 text-center">
            <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center mx-auto mb-3 text-text-subtle">
              <KeyRound size={24} />
            </div>
            <h3 className="text-sm font-semibold text-text">No TURN keys configured</h3>
            <p className="text-text-muted text-xs mt-1">
              Clients fall back to the deployed <code className="font-mono text-brand-500">TURN_KEY_ID</code> secret, or STUN-only if that is gone.
            </p>
          </div>
        ) : (
          <div className="card-glass overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2/60 border-b border-border-subtle text-[11px] font-mono uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Last Used</th>
                  <th className="px-4 py-3">Status</th>
                  {canManage && <th className="px-4 py-3 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle/50">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-3.5">
                      <div className="font-mono text-xs text-text">{item.keyId.slice(0, 12)}…</div>
                      <div className="text-[10px] text-text-subtle font-mono mt-0.5">
                        {item.label || "(no label)"} · secret {item.secretTail}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {canManage ? (
                        <select
                          className="px-2 py-1 text-[11px] font-mono border border-border-subtle rounded-lg bg-surface-2/80 text-text focus:outline-none"
                          value={item.scope}
                          onChange={(e) => handleScope(item, e.target.value)}
                        >
                          {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-surface-2 border border-border-subtle text-text">{item.scope}</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-text-muted font-mono">{formatTime(item.lastUsedAt)}</td>
                    <td className="px-4 py-3.5">
                      {item.enabled ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                          <Check size={13} /><span>Active</span>
                        </span>
                      ) : (
                        <span className="text-xs font-mono text-text-subtle px-2 py-0.5 rounded bg-surface-2">Disabled</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <button
                          onClick={() => handleToggle(item)}
                          className="text-xs font-semibold text-brand-500 hover:text-brand-400 px-2.5 py-1 rounded-lg hover:bg-brand-500/10 transition-colors"
                        >
                          {item.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="ml-1 p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-red-500/10 transition-colors"
                          aria-label="Delete key"
                        >
                          <Trash2 size={14} />
                        </button>
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
