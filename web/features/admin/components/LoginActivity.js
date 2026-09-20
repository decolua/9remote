"use client";

import { Shield, AlertCircle } from "@/shared/components/ui/Icon";

const REASONS = {
  ok: "Success",
  badPassword: "Wrong password",
  unknownUser: "Unknown user",
  turnstile: "Captcha failed",
  locked: "Locked out"
};

function formatTime(value) {
  try {
    return new Date(value + "Z").toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return value;
  }
}

// Recent admin login attempts — with a single operator, any failure here is
// someone probing, and any success that wasn't you is the loudest alarm.
export default function LoginActivity({ items }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Shield size={16} className="text-brand-500" />
        <h2 className="text-base font-semibold tracking-tight text-text">Login Activity</h2>
        <span className="text-xs text-text-subtle font-mono">last {items.length}</span>
      </div>
      <div className="card-glass overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-surface-2/60 border-b border-border-subtle text-[11px] font-mono uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-4 py-2.5">Time</th>
              <th className="px-4 py-2.5">User</th>
              <th className="px-4 py-2.5">IP</th>
              <th className="px-4 py-2.5 text-right">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50">
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-text-muted">No login attempts recorded yet</td>
              </tr>
            )}
            {items.map((a, i) => (
              <tr key={i} className="hover:bg-surface-2/40 transition-colors">
                <td className="px-4 py-2.5 text-xs text-text-muted whitespace-nowrap">{formatTime(a.createdAt)}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-text">{a.username}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-text-muted">{a.ip}</td>
                <td className="px-4 py-2.5 text-right">
                  {a.ok ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
                      <Shield size={11} /> OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-red-500/10 text-danger border-red-500/20">
                      <AlertCircle size={11} /> {REASONS[a.reason] || a.reason}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
