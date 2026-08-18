"use client";

import Spinner from "@/shared/components/ui/Spinner";
import { useI18n } from "@/shared/i18n";

// Cinematic full-screen wait state — same backdrop language as the login page. Covers
// the workspace UI while no transport is alive, so empty workspace lists / welcome
// cards never flash during a PWA resume or reconnect.
export default function ReconnectScreen({ label }) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center animate-in fade-in duration-300">
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
      </div>
    </div>
  );
}
