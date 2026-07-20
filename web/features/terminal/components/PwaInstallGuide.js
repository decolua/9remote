"use client";

import { useState, useEffect } from "react";
import { Smartphone, Monitor, Check, Copy, Download } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import { maskApiKey } from "@/shared/utils/formatters";
import { useI18n } from "@/shared/i18n";

/**
 * PWA Installation Guide Component
 * Detects platform and shows appropriate installation instructions
 */
export default function PwaInstallGuide() {
  const { t } = useI18n();
  const [platform, setPlatform] = useState("unknown");
  const [copied, setCopied] = useState(false);
  const [installState, setInstallState] = useState("idle");
  const apiKey = useSlideMenuStore((s) => s.context.apiKey);
  // Shared install state — canInstall flips true only on Chromium.
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);
  const install = usePwaInstallStore((s) => s.install);

  useEffect(() => {
    // Detect platform
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(userAgent);
    const isAndroid = /android/.test(userAgent);
    const isMacOS = /mac/.test(userAgent);
    const isWindows = /win/.test(userAgent);

    if (isIOS) {
      setPlatform("ios");
    } else if (isAndroid) {
      setPlatform("android");
    } else if (isMacOS) {
      setPlatform("macos");
    } else if (isWindows) {
      setPlatform("windows");
    } else {
      setPlatform("desktop");
    }
  }, []);

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
          <p className="text-text font-medium mb-1">{t("pwaGuide.tapShareButton")}</p>
          <p className="text-text-muted text-sm">{t("pwaGuide.tapShareHint")}</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-text font-medium mb-1">{t("pwaGuide.addToHome")}</p>
          <p className="text-text-muted text-sm">{t("pwaGuide.addToHomeHint")}</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {3 + stepOffset}
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

      {/* Install button — Android Chrome fires beforeinstallprompt */}
      {renderInstallButton()}

      {/* Manual fallback — Firefox/other browsers */}
      {canInstall ? (
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
            {2 + stepOffset}
          </div>
          <div className="flex-1">
            <p className="text-text font-medium mb-1">{t("pwaGuide.openAppPasteKey")}</p>
            <p className="text-text-muted text-sm">{t("pwaGuide.openAppPasteKeyHint")}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
              {1 + stepOffset}
            </div>
            <div className="flex-1">
              <p className="text-text font-medium mb-1">{t("pwaGuide.openMenu")}</p>
              <p className="text-text-muted text-sm">{t("pwaGuide.openMenuHint")}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
              {2 + stepOffset}
            </div>
            <div className="flex-1">
              <p className="text-text font-medium mb-1">{t("pwaGuide.installApp")}</p>
              <p className="text-text-muted text-sm">{t("pwaGuide.installAppHint")}</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
              {3 + stepOffset}
            </div>
            <div className="flex-1">
              <p className="text-text font-medium mb-1">{t("pwaGuide.openAppPasteKey")}</p>
              <p className="text-text-muted text-sm">{t("pwaGuide.openAppPasteKeyHint")}</p>
            </div>
          </div>
        </>
      )}
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
