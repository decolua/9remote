"use client";

import { useState } from "react";
import { Monitor, FolderOpen, Globe, Download, Sparkles, LogOut, Palette, Check } from "@/shared/components/ui/Icon";
import { THEMES } from "@/features/terminal/constants/themes";
import { vibrate } from "@/shared/utils/vibration";

/**
 * Shared menu items for SlideMenu (DRY)
 * Used by both SessionList and Terminal
 */
export default function MenuItems({
  onRemote,
  onFiles,
  onSites,
  onInstallApp,
  onCodespace,
  onLogout,
  connected = true,
  remoteAvailable = false,
  codespaceInfo = null,
  showTheme = false,
  theme = "default",
  onThemeChange,
  hideActions = [] // Array of actions to hide: ['remote', 'files', 'sites']
}) {
  const [expandedSection, setExpandedSection] = useState(null);

  const handleThemeChange = (newTheme) => {
    vibrate();
    if (onThemeChange) {
      onThemeChange(newTheme);
    }
    setExpandedSection(null);
  };

  return (
    <div className="p-4 space-y-2">
      {/* Theme - only for Terminal */}
      {showTheme && (
        <div className="border border-dark-400 rounded-brand-lg overflow-hidden menu-item-stagger-1">
          <button
            onClick={() => { vibrate(); setExpandedSection(expandedSection === "theme" ? null : "theme"); }}
            className="w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white text-left flex items-center justify-between transition-colors"
          >
            <div className="flex items-center gap-3">
              <Palette className="text-brand-500" size={20} />
              <span className="font-medium">Theme</span>
            </div>
            <span className="text-dark-100 text-sm">{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
          </button>
          {expandedSection === "theme" && (
            <div className="bg-dark-700/50 border-t border-dark-400 p-2 space-y-1 slide-in-top">
              {Object.keys(THEMES).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  className={`w-full px-3 py-2 text-left text-sm rounded-brand flex items-center justify-between transition-all duration-200 ${
                    theme === t ? "bg-brand-500 text-white" : "text-dark-50 hover:bg-dark-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full border-2 border-dark-100" style={{ background: THEMES[t].background }} />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </div>
                  {theme === t && <Check size={16} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Remote Desktop */}
      {!hideActions.includes('remote') && remoteAvailable && onRemote && (
        <button
          onClick={() => { vibrate(); onRemote(); }}
          disabled={!connected}
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-2" : "menu-item-stagger-1"
          } ${
            connected
              ? "bg-dark-700 hover:bg-dark-600 text-white"
              : "bg-dark-700/30 text-dark-200 cursor-not-allowed"
          }`}
        >
          <Monitor className="text-brand-500" size={20} />
          <span className="font-medium">Remote Desktop</span>
        </button>
      )}

      {/* Files */}
      {!hideActions.includes('files') && onFiles && (
        <button
          onClick={() => { vibrate(); onFiles(); }}
          disabled={!connected}
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-3" : "menu-item-stagger-2"
          } ${
            connected
              ? "bg-dark-700 hover:bg-dark-600 text-white"
              : "bg-dark-700/30 text-dark-200 cursor-not-allowed"
          }`}
        >
          <FolderOpen className="text-brand-500" size={20} />
          <span className="font-medium">Files</span>
        </button>
      )}

      {/* Sites */}
      {!hideActions.includes('sites') && onSites && (
        <button
          onClick={() => { vibrate(); onSites(); }}
          disabled={!connected}
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-4" : "menu-item-stagger-3"
          } ${
            connected
              ? "bg-dark-700 hover:bg-dark-600 text-white"
              : "bg-dark-700/30 text-dark-200 cursor-not-allowed"
          }`}
        >
          <Globe className="text-brand-500" size={20} />
          <span className="font-medium">Sites</span>
        </button>
      )}

      {/* Install App */}
      {onInstallApp && (
        <button
          onClick={() => { vibrate(); onInstallApp(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-5" : "menu-item-stagger-4"
          }`}
        >
          <Download className="text-brand-500" size={20} />
          <span className="font-medium">Install App</span>
        </button>
      )}

      {/* Codespace */}
      {codespaceInfo?.isCodespaces && onCodespace && (
        <button
          onClick={() => { vibrate(); onCodespace(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-6" : "menu-item-stagger-5"
          }`}
        >
          <Sparkles className="text-brand-500" size={20} />
          <span className="font-medium">Codespace</span>
        </button>
      )}

      {/* Logout */}
      {onLogout && (
        <button
          onClick={() => { vibrate(); onLogout(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-red-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 hover:border-red-500 ${
            showTheme ? "menu-item-stagger-7" : "menu-item-stagger-6"
          }`}
        >
          <LogOut className="text-red-400" size={20} />
          <span className="font-medium">Logout</span>
        </button>
      )}
    </div>
  );
}
