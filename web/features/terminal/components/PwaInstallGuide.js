"use client";

import { useState, useEffect } from "react";
import { Smartphone, Monitor, Download, Share, Menu, MoreVertical, Check, Copy } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { maskApiKey } from "@/shared/utils/formatters";

/**
 * PWA Installation Guide Component
 * Detects platform and shows appropriate installation instructions
 */
export default function PwaInstallGuide() {
  const [platform, setPlatform] = useState("unknown");
  const [isInstalled, setIsInstalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const apiKey = useSlideMenuStore((s) => s.context.apiKey);

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

    // Check if already installed
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setIsInstalled(true);
    }
  }, []);

  const handleCopyKey = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
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
        <div className="flex-1">
          <p className="text-white font-medium mb-2">Copy Your Key</p>
          <p className="text-dark-100 text-sm mb-2">Save this key first — you'll need it to login after installing</p>
          <button
            onClick={handleCopyKey}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-brand border transition-colors ${
              copied
                ? "bg-green-500/10 border-green-500/30"
                : "bg-dark-700 border-dark-400 hover:border-brand-500/50"
            }`}
          >
            <code className="text-sm text-dark-50 font-mono truncate">{maskApiKey(apiKey)}</code>
            <span className={`flex items-center gap-1 text-sm flex-shrink-0 ${copied ? "text-green-400" : "text-brand-500"}`}>
              {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy</>}
            </span>
          </button>
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
          <p className="text-white font-medium mb-1">Tap Share Button</p>
          <p className="text-dark-100 text-sm">Tap the <Share size={14} className="inline mx-1" /> share button at the bottom of Safari</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Add to Home Screen</p>
          <p className="text-dark-100 text-sm">Scroll down and tap "Add to Home Screen"</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {3 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Open App & Paste Key</p>
          <p className="text-dark-100 text-sm">Open the installed app and paste your key to login</p>
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
          <p className="text-white font-medium mb-1">Open Menu</p>
          <p className="text-dark-100 text-sm">Tap the <MoreVertical size={14} className="inline mx-1" /> menu button (three dots) in Chrome</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Install App</p>
          <p className="text-dark-100 text-sm">Tap "Install app" or "Add to Home screen"</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {3 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Open App & Paste Key</p>
          <p className="text-dark-100 text-sm">Open the installed app and paste your key to login</p>
        </div>
      </div>
    </div>
  );

  const renderDesktopInstructions = () => (
    <div className="space-y-4">
      {renderCopyKeyStep()}

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {1 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Look for Install Icon</p>
          <p className="text-dark-100 text-sm">Look for the <Download size={14} className="inline mx-1" /> install icon in the address bar</p>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-brand-500/10 rounded-brand flex items-center justify-center text-brand-500 font-semibold">
          {2 + stepOffset}
        </div>
        <div className="flex-1">
          <p className="text-white font-medium mb-1">Click Install & Paste Key</p>
          <p className="text-dark-100 text-sm">Click install, open the app, and paste your key to login</p>
        </div>
      </div>

      <div className="mt-6 p-3 bg-blue-500/10 border border-blue-500/20 rounded-brand">
        <p className="text-blue-200 text-sm">
          💡 Alternative: Open browser menu → "Install 9Remote" or "Create shortcut"
        </p>
      </div>
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
          <p className="text-dark-100 text-center py-8">
            Loading platform detection...
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
        return "iOS (iPhone/iPad)";
      case "android":
        return "Android";
      case "macos":
        return "macOS";
      case "windows":
        return "Windows";
      default:
        return "Desktop";
    }
  };

  if (isInstalled) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="inline-flex p-4 bg-green-500/10 rounded-brand-lg mb-4">
            <Check className="text-green-500" size={48} />
          </div>
          <p className="text-white font-semibold mb-2">Already Installed!</p>
          <p className="text-dark-100 text-sm">
            You're already using 9Remote as an installed app
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Platform Info */}
      <div className="flex items-center gap-3 pb-4 border-b border-dark-400">
        <div className="p-2 bg-brand-500/10 rounded-brand">
          {getPlatformIcon()}
        </div>
        <div>
          <p className="text-white font-medium">Installation Guide</p>
          <p className="text-dark-100 text-sm">{getPlatformName()}</p>
        </div>
      </div>

      {/* Benefits */}
      {/* <div className="bg-dark-700 rounded-brand-lg p-4 space-y-2">
        <p className="text-white font-medium text-sm mb-3">Why Install?</p>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-dark-100 text-sm">Quick access from home screen</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-dark-100 text-sm">Works offline when cached</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-dark-100 text-sm">Full-screen app experience</p>
        </div>
        <div className="flex items-start gap-2">
          <Check className="text-green-500 flex-shrink-0" size={16} />
          <p className="text-dark-100 text-sm">No browser UI clutter</p>
        </div>
      </div> */}

      {/* Instructions */}
      <div>
        <p className="text-white font-medium mb-4">Installation Steps:</p>
        {renderInstructions()}
      </div>
    </div>
  );
}
