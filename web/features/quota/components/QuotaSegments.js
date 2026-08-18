"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { PROVIDER_LABELS, quotaBarColor } from "../constants/quotaConfig";

// One segment per provider that has quota data. Click opens a popover with the
// windows' reset times (and per-model buckets for Gemini) or the fetch error.

const WINDOW_LABELS = [
  ["session", "5h"],
  ["weekly", "wk"],
  ["monthly", "mo"]
];

function formatReset(resetsAt) {
  if (!resetsAt) return "";
  const date = new Date(resetsAt);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function MiniBar({ usedPct }) {
  return (
    <span className="w-10 h-[5px] rounded-full bg-text-muted/20 overflow-hidden flex-shrink-0">
      <span
        className={`block h-full rounded-full transition-all duration-300 ${quotaBarColor(usedPct)}`}
        style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
      />
    </span>
  );
}

function WindowRow({ label, window: w }) {
  if (!w) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 truncate text-text-muted">{label}</span>
      <span className="w-9 text-right tabular-nums">{Math.round(w.usedPercent)}%</span>
      <MiniBar usedPct={w.usedPercent} />
      {w.resetsAt && <span className="text-text-subtle whitespace-nowrap">{formatReset(w.resetsAt)}</span>}
    </div>
  );
}

function ProviderPopover({ p, onClose }) {
  const ref = useRef(null);
  const { t } = useI18n();
  useEffect(() => {
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 z-50 w-64 p-3 rounded-brand-lg bg-surface-2 border border-border shadow-lg text-[11px] flex flex-col gap-2"
    >
      <div className="font-medium">{PROVIDER_LABELS[p.provider] || p.provider}</div>
      {WINDOW_LABELS.map(([key, label]) => <WindowRow key={key} label={label} window={p[key]} />)}
      {(p.buckets || []).map((b) => <WindowRow key={b.name} label={b.name} window={b} />)}
      {!p.session && !p.weekly && !p.monthly && !(p.buckets || []).length && (
        <div className="text-text-muted">{p.error || t("terminal.quotaNoData")}</div>
      )}
      {p.error && (p.session || p.weekly || p.monthly) && (
        <div className="text-text-subtle border-t border-border-subtle pt-1.5">{p.error}</div>
      )}
    </div>
  );
}

export default function QuotaSegments({ quota }) {
  const [openProvider, setOpenProvider] = useState(null);
  const { t } = useI18n();
  if (!quota?.providers) return null;

  const visible = Object.values(quota.providers).filter(
    (p) => p && p.status === "ok" && (p.session || p.weekly || p.monthly || p.buckets?.length)
  );
  if (!visible.length) return null;

  return (
    <span className="relative flex items-center gap-1 flex-shrink-0">
      {visible.map((p) => {
        // Segment preview = the tightest window the provider reports.
        const preview = p.session || p.weekly || p.monthly || p.buckets[0];
        return (
          <span key={p.provider} className="relative">
            <button
              type="button"
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-[2px] hover:bg-white/10 transition-colors"
              onClick={() => setOpenProvider(openProvider === p.provider ? null : p.provider)}
              title={`${PROVIDER_LABELS[p.provider] || p.provider} ${t("terminal.quotaUsageTitle")}`}
            >
              <span className="text-text-subtle">{PROVIDER_LABELS[p.provider] || p.provider}</span>
              <MiniBar usedPct={preview.usedPercent} />
              <span className="tabular-nums">{Math.round(preview.usedPercent)}%</span>
            </button>
            {openProvider === p.provider && (
              <ProviderPopover p={p} onClose={() => setOpenProvider(null)} />
            )}
          </span>
        );
      })}
    </span>
  );
}
