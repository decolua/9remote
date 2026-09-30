"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { isMobileAppUA, appVersionOf, isVersionBelow } from "@/shared/lib/appVersionGate";

// Store deep links — market:// / itms-apps:// open the store page directly in
// the WebView shell (its onShouldStartLoadWithRequest routes non-web URLs to
// the OS via Linking, present since the first store build).
const STORE_URLS = {
  android: "market://details?id=cc.remote9.app",
  ios: "itms-apps://apps.apple.com/app/id6796664210"
};

// Force-update gate for the mobile shells. The web inside the WebView is
// always fresh, so a page-side gate reaches every installed build — including
// ones too old to carry a native updater. Fail-open: fetch/parse problems
// never block the app.
// Platform of the running shell; the overlay only renders client-side, so
// reading navigator at render time is safe.
function detectShellPlatform() {
  if (typeof navigator === "undefined") return "android";
  return window.DEVICE_INFO?.platform || (/iPhone|iPad|iPod/i.test(navigator.userAgent) ? "ios" : "android");
}

export default function AppUpdateGate() {
  const { t } = useI18n();
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    if (!window.ReactNativeWebView && !isMobileAppUA(ua)) return; // browser/PWA: no gate
    const platform = detectShellPlatform();

    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/version?platform=${platform}&_t=${Date.now()}`);
        if (!r.ok || dead) return;
        const data = await r.json();
        const min = data?.minAppVersion;
        if (dead || !min) return;
        const v = appVersionOf(ua, window.DEVICE_INFO);
        // A shell reporting no version at all predates version reporting —
        // treat as outdated rather than fail open.
        if (v === null || isVersionBelow(v, min)) setBlocked(true);
      } catch {
        // Offline / API down — fail open.
      }
    })();
    return () => { dead = true; };
  }, []);

  if (!blocked) return null;
  const storeUrl = STORE_URLS[detectShellPlatform()] || STORE_URLS.android;
  return (
    <div className="fixed inset-0 z-[300] flex flex-col items-center justify-center gap-4 bg-[#0b0d0c] px-8 text-center">
      <span className="material-symbols-rounded text-[56px] text-[#E56A4A]">system_update_alt</span>
      <h2 className="text-lg font-semibold text-white">{t("appUpdate.title")}</h2>
      <p className="max-w-xs text-sm text-white/60">{t("appUpdate.body")}</p>
      <a
        href={storeUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 rounded-brand bg-[#E56A4A] px-6 py-2.5 text-sm font-semibold text-white"
      >
        {t("appUpdate.action")}
      </a>
    </div>
  );
}
