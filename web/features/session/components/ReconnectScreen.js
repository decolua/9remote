"use client";

import { useState, useEffect } from "react";
import Spinner from "@/shared/components/ui/Spinner";
import { RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

const RELOAD_TIMEOUT_MS = 6000;

// Cinematic full-screen wait state — same backdrop language as the login page. Covers
// the workspace UI while no transport is alive, so empty workspace lists / welcome
// cards never flash during a PWA resume or reconnect.
// `inline` — fill the parent container instead of the viewport (empty state in the
// panes area, where the sidebar still shows around it).
export default function ReconnectScreen({ label, inline = false }) {
  const { t } = useI18n();
  const [showReload, setShowReload] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowReload(true), RELOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  const handleReload = () => {
    vibrate();
    setReloading(true);
    // Break the auto-login loop: land on the login page, where the saved key shows the host's real state.
    try { sessionStorage.setItem("9remote_manual_disconnect", "1"); } catch {}
    setTimeout(() => window.location.reload(), 150);
  };

  return (
    <div className={`${inline ? "absolute inset-0 z-10" : "fixed inset-0 z-40"} flex items-center justify-center animate-in fade-in duration-300`}>
      <div className="cine-bg" aria-hidden>
        <div className="cine-grid" />
      </div>
      <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-text animate-pulse-glow" />
          <span className="text-[15px] font-semibold text-text tracking-wide">9Remote</span>
        </div>
        <Spinner size="lg" />
        <p className="text-sm text-text-muted">{label || t("connection.retrying")}</p>
        {showReload && (
          <button
            onClick={handleReload}
            disabled={reloading}
            className="mt-2 px-4 py-2 bg-surface-2 hover:bg-surface-3 active:scale-[0.96] disabled:opacity-70 border border-border-subtle rounded-brand text-xs font-medium text-text transition-all duration-150 flex items-center gap-2 animate-in fade-in duration-300"
          >
            <RefreshCw size={14} className={`text-brand-500 ${reloading ? "animate-spin" : ""}`} />
            <span>{t("menu.reloadWeb") || "Reload"}</span>
          </button>
        )}
      </div>
    </div>
  );
}
