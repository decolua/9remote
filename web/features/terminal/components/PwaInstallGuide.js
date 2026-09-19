"use client";

import { useState, useEffect } from "react";
import { Smartphone, Monitor, Check, Copy, Download } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import { maskApiKey } from "@/shared/utils/formatters";
import { useI18n } from "@/shared/i18n";

const APP_STORE_URL = "https://apps.apple.com/us/app/9remote/id6796664210";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=cc.remote9.app&pli=1";

/**
 * PWA & Mobile Installation Guide Component
 * Detects platform and shows appropriate installation instructions
 */
function detectPlatform() {
  if (typeof navigator === "undefined") return "unknown";
  const userAgent = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(userAgent)) return "ios";
  if (/android/.test(userAgent)) return "android";
  if (/mac/.test(userAgent)) return "macos";
  if (/win/.test(userAgent)) return "windows";
  return "desktop";
}

export default function PwaInstallGuide() {
  const { t } = useI18n();
  const [platform] = useState(detectPlatform);
  const [copied, setCopied] = useState(false);
  const [installState, setInstallState] = useState("idle");
  const apiKey = useSlideMenuStore((s) => s.context.apiKey);
  // Shared install state — canInstall flips true only on Chromium.
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);
  const install = usePwaInstallStore((s) => s.install);

  const handleInstallClick = async () => {
    setInstallState("installing");
    const outcome = await install();
    setInstallState(outcome === "accepted" ? "done" : "idle");
  };

  const copyToClipboard = async (text) => {
    // Try modern clipboard API first
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // Fallback for iOS / non-secure / older browsers
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopyKey = async () => {
    if (!apiKey) return;
    const ok = await copyToClipboard(apiKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Step number offset: 1 if has apiKey (copy key is step 1), 0 otherwise
  const stepOffset = apiKey ? 1 : 0;

  const renderCopyKeyStep = () => {
    if (!apiKey) return null;
    return (
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          1
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-text font-medium mb-2">{t("pwaGuide.copyYourKey")}</p>
          <p className="text-text-muted text-sm mb-2">{t("pwaGuide.copyKeyHint")}</p>
          <div
            className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-brand border transition-colors ${
              copied
                ? "bg-green-500/10 border-green-500/30"
                : "bg-bg border-border hover:border-brand-500/50 focus-within:border-brand-500/50"
            }`}
          >
            <button
              type="button"
              onClick={handleCopyKey}
              className="flex-1 min-w-0 text-left bg-transparent outline-none border-0 p-0 cursor-pointer"
              aria-label={t("pwaGuide.tapToCopyApiKey")}
            >
              <code className="block text-sm text-text font-mono truncate">
                {maskApiKey(apiKey)}
              </code>
            </button>
            <button
              type="button"
              onClick={handleCopyKey}
              className={`flex items-center gap-1 text-sm flex-shrink-0 ${copied ? "text-green-400" : "text-brand-500"}`}
            >
              {copied ? <><Check size={14} /> {t("pwaGuide.copiedBang")}</> : <><Copy size={14} /> {t("pwaGuide.copy")}</>}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderIOSInstructions = () => (
    <div className="space-y-4">
      {renderCopyKeyStep()}

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {1 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-text font-medium mb-1.5">Download 9Remote on App Store</p>
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold rounded-brand transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.38c.62-.75 1.04-1.8 0.92-2.85-.9.04-2 .6-2.65 1.35-.58.66-1.09 1.73-.95 2.76.99.08 2.03-.51 2.68-1.26z" />
            </svg>
            Get on App Store
          </a>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-text font-medium mb-1">{t("pwaGuide.openAppPasteKey")}</p>
          <p className="text-text-muted text-sm">{t("pwaGuide.openAppPasteKeyHint")}</p>
        </div>
      </div>
    </div>
  );

  const renderAndroidInstructions = () => (
    <div className="space-y-4">
      {renderCopyKeyStep()}

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {1 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-text font-medium mb-1.5">Download 9Remote on Google Play</p>
          <a
            href={PLAY_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold rounded-brand transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.609 1.814L13.793 12 3.61 22.186a2.128 2.128 0 0 1-.22-.964V2.778c0-.36.08-.694.22-.964zm11.233 11.234l2.584 2.584-11.834 6.83 9.25-9.414zm0-2.096L5.592 1.538l11.834 6.83-2.584 2.584zm1.485 1.048l3.633 2.098a1.328 1.328 0 0 0 0-2.296l-3.633-2.098-1.048 1.048 1.048 1.048z" />
            </svg>
            Get on Google Play
          </a>
        </div>
      </div>

      {canInstall && (
        <div className="pt-2 border-t border-border">
          <p className="text-xs text-text-muted mb-2">Or install directly as Web App (PWA):</p>
          {renderInstallButton()}
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-text font-medium mb-1">{t("pwaGuide.openAppPasteKey")}</p>
          <p className="text-text-muted text-sm">{t("pwaGuide.openAppPasteKeyHint")}</p>
        </div>
      </div>
    </div>
  );

  // Shared install button — Chromium (Chrome/Edge/Android Chrome) fires beforeinstallprompt.
  // Inline install step — text on the left, small Install button on the right.
  // Mirrors the copy-key step layout. Chromium-only (canInstall gate).
  const renderInstallButton = () => {
    if (!canInstall) return null;
    return (
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {1 + stepOffset}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-text font-medium mb-1">{t("pwaGuide.installNow")}</p>
          <p className="text-text-muted text-sm">{t("pwaGuide.installNowHint")}</p>
        </div>
        <button
          type="button"
          onClick={handleInstallClick}
          disabled={installState === "installing"}
          className="flex-shrink-0 flex items-center gap-1 px-3 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-brand transition-all duration-150 active:scale-[0.97] disabled:opacity-70 disabled:cursor-wait"
        >
          <Download size={14} />
          {installState === "installing" ? t("pwaGuide.installing") : t("pwaGuide.installNow")}
        </button>
      </div>
    );
  };

  const renderDesktopInstructions = () => (
    <div className="space-y-4">
      {renderCopyKeyStep()}

      {/* Install button — only Chromium (Chrome/Edge) fires beforeinstallprompt */}
      {renderInstallButton()}

      {/* After install, paste key — shown once install step is rendered */}
      {canInstall && (
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
            {2 + stepOffset}
          </div>
          <div className="flex-1">
            <p className="text-text font-medium mb-1">{t("pwaGuide.openAppPasteKey")}</p>
            <p className="text-text-muted text-sm">{t("pwaGuide.openAppPasteKeyHint")}</p>
          </div>
        </div>
      )}

      {/* Manual fallback — Firefox/Safari/Chrome-before-engagement */}
      {!canInstall && (
        <>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
              {1 + stepOffset}
            </div>
            <div className="flex-1">
              <p className="text-text font-medium mb-1">{t("pwaGuide.lookInstallIcon")}</p>
              <p className="text-text-muted text-sm">{t("pwaGuide.lookInstallIconHint")}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
              {2 + stepOffset}
            </div>
            <div className="flex-1">
              <p className="text-text font-medium mb-1">{t("pwaGuide.clickInstallPaste")}</p>
              <p className="text-text-muted text-sm">{t("pwaGuide.clickInstallPasteHint")}</p>
            </div>
          </div>

          <div className="mt-6 p-3 bg-blue-500/10 rounded-brand">
            <p className="text-blue-200 text-sm">
              💡 {t("pwaGuide.alternativeHint")}
            </p>
          </div>
        </>
      )}
    </div>
  );

  const renderInstructions = () => {
    switch (platform) {
      case "ios":
        return renderIOSInstructions();
      case "android":
        return renderAndroidInstructions();
      case "macos":
      case "windows":
      case "desktop":
        return renderDesktopInstructions();
      default:
        return (
          <p className="text-text-muted text-center py-8">
            {t("pwaGuide.loadingPlatform")}
          </p>
        );
    }
  };

  const getPlatformIcon = () => {
    switch (platform) {
      case "ios":
      case "android":
        return <Smartphone className="text-brand-500" size={24} />;
      default:
        return <Monitor className="text-brand-500" size={24} />;
    }
  };

  const getPlatformName = () => {
    switch (platform) {
      case "ios":
        return t("pwaGuide.iosPlatform");
      case "android":
        return t("pwaGuide.androidPlatform");
      case "macos":
        return t("pwaGuide.macosPlatform");
      case "windows":
        return t("pwaGuide.windowsPlatform");
      default:
        return t("pwaGuide.desktopPlatform");
    }
  };

  if (isInstalled) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="inline-flex p-4 bg-green-500/10 rounded-brand-lg mb-4">
            <Check className="text-green-500" size={48} />
          </div>
          <p className="text-text font-semibold mb-2">{t("pwaGuide.alreadyInstalled")}</p>
          <p className="text-text-muted text-sm">
            {t("pwaGuide.alreadyInstalledHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Platform Info */}
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <div className="p-2 bg-brand-500/10 rounded-brand">
          {getPlatformIcon()}
        </div>
        <div>
          <p className="text-text font-medium">{t("pwaGuide.installationGuide")}</p>
          <p className="text-text-muted text-sm">{getPlatformName()}</p>
        </div>
      </div>

      {/* Benefits */}
      {/* <div className="bg-bg rounded-brand-lg p-4 space-y-2">
        <p className="text-text font-medium text-sm mb-3">Why Install?</p>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-text-muted text-sm">Quick access from home screen</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-text-muted text-sm">Works offline when cached</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-text-muted text-sm">Full-screen app experience</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-text-muted text-sm">No browser UI clutter</p>
        </div>
      </div> */}

      {/* Instructions */}
      <div>
        <p className="text-text font-medium mb-4">{t("pwaGuide.installationSteps")}</p>
        {renderInstructions()}
      </div>
    </div>
  );
}
