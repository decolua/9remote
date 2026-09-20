"use client";

import { useState, useEffect } from "react";
import { X } from "@/shared/components/ui/Icon";
import { APP_STORE_URL, PLAY_STORE_URL } from "../constants/landingConfig";

export default function MobileStoreBanner() {
  const [target, setTarget] = useState(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem("9remote_dismiss_store_banner") === "1") return;
    } catch {}

    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) {
      setTarget({
        storeName: "Apple App Store",
        url: APP_STORE_URL,
        btnLabel: "Get"
      });
      setDismissed(false);
    } else if (/Android/i.test(ua)) {
      setTarget({
        storeName: "Google Play",
        url: PLAY_STORE_URL,
        btnLabel: "Install"
      });
      setDismissed(false);
    }
  }, []);

  if (dismissed || !target) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem("9remote_dismiss_store_banner", "1");
    } catch {}
  };

  return (
    <div className="fixed bottom-0 inset-x-0 z-40 sm:hidden px-4 py-2.5 bg-surface/90 backdrop-blur-lg border-t border-border-subtle shadow-2xl flex items-center justify-between gap-3 pb-[max(0.65rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3 min-w-0">
        <img
          src="/icon-192.png"
          alt="9Remote"
          className="w-9 h-9 rounded-xl object-contain shadow-md shrink-0 border border-border-subtle/50"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text truncate leading-tight">9Remote</p>
          <p className="text-[11px] text-text-muted truncate leading-tight mt-0.5">{target.storeName}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <a
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3.5 py-1.5 bg-brand-500 hover:bg-brand-600 active:scale-95 text-white text-xs font-semibold rounded-full shadow-md shadow-brand-500/20 transition-all duration-150"
        >
          {target.btnLabel}
        </a>
        <button
          onClick={handleDismiss}
          className="p-1 text-text-muted hover:text-text active:scale-90 transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
