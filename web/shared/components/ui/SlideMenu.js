"use client";

import { useEffect, useCallback, useState } from "react";
import { X, ChevronLeft, Sun, Moon, Github, Star } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import MenuItems from "@/features/terminal/components/MenuItems";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import CommandNotesPanel from "@/features/terminal/components/CommandNotes/CommandNotesPanel";
import CommunityModal from "@/features/terminal/components/CommunityModal";
import LanguageModal from "@/shared/components/ui/LanguageModal";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { useTheme } from "@/shared/theme/ThemeProvider";
import CodespacePanel from "@/features/codespace/components/CodespacePanel";
import SettingsDialog from "@/features/terminal/components/SettingsDialog";
import BackgroundPickerSheet from "@/features/terminal/components/BackgroundPickerSheet";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { useGithubStars } from "@/shared/hooks/useGithubStars";
import { GITHUB_REPO_URL, SHOW_GITHUB_STAR } from "@/shared/constants/github";

/**
 * SlideMenu - Global full-screen menu that slides from right to left
 * Uses Zustand store for state management
 */
export default function SlideMenu() {
  const { t, locale } = useI18n();
  const { formattedStars } = useGithubStars();
  const currentLocale = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];
  const isOpen = useSlideMenuStore((s) => s.isOpen);
  const activePanel = useSlideMenuStore((s) => s.activePanel);
  const context = useSlideMenuStore((s) => s.context);
  const callbacks = useSlideMenuStore((s) => s.callbacks);
  const close = useSlideMenuStore((s) => s.close);
  const setActivePanel = useSlideMenuStore((s) => s.setActivePanel);
  const openMenu = useSlideMenuStore((s) => s.openMenu);

  // Chromium sets canInstall via beforeinstallprompt; iOS Safari/Firefox stay false.
  const install = usePwaInstallStore((s) => s.install);
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);

  const [commandNotesOpen, setCommandNotesOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const { theme: appTheme, toggleTheme } = useTheme();

  // Desktop gets a centered two-pane settings dialog; the drawer stays for phones.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) {
        close();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, close]);

  // Panel-specific handlers
  const handleOpenPwa = useCallback(() => setActivePanel("pwa"), [setActivePanel]);
  const handleOpenCodespace = useCallback(() => setActivePanel("codespace"), [setActivePanel]);

  const handleBack = useCallback(() => {
    vibrate();
    setActivePanel("menu");
  }, [setActivePanel]);

  // Menu action handlers - close menu after action
  const handleRemote = useCallback(() => {
    close();
    callbacks.onRemote?.();
  }, [close, callbacks]);

  const handleFiles = useCallback(() => {
    close();
    callbacks.onFiles?.();
  }, [close, callbacks]);

  // Chromium: trigger native install dialog directly. Otherwise open the
  // manual guide panel (iOS Safari / Firefox / pre-engagement).
  const handleInstallApp = useCallback(() => {
    if (canInstall) {
      close();
      install();
    } else {
      handleOpenPwa();
    }
  }, [canInstall, close, install, handleOpenPwa]);

  const handleCodespace = useCallback(() => {
    handleOpenCodespace();
  }, [handleOpenCodespace]);

  const handleLogout = useCallback(() => {
    // Close menu first, then call logout callback
    // Logout callback may show confirm dialog, so we close menu first
    close();
    // Use setTimeout to ensure menu is closed before callback runs
    setTimeout(() => {
      callbacks.onLogout?.();
    }, 50);
  }, [close, callbacks]);

  const handleThemeChange = useCallback((theme) => {
    callbacks.onThemeChange?.(theme);
  }, [callbacks]);

  const handleStopCodespace = useCallback(() => {
    close();
    callbacks.onStopCodespace?.();
  }, [close, callbacks]);

  // Host update/restart: confirm dialog shows after menu closes
  const handleUpdate = useCallback(() => {
    close();
    setTimeout(() => callbacks.onUpdate?.(), 50);
  }, [close, callbacks]);

  const handleRestart = useCallback(() => {
    close();
    setTimeout(() => callbacks.onRestart?.(), 50);
  }, [close, callbacks]);

  const handleCommandNotes = useCallback(() => {
    close();
    setCommandNotesOpen(true);
  }, [close]);

  const handleCloseCommandNotes = useCallback(() => {
    setCommandNotesOpen(false);
  }, []);

  const handleCommunity = useCallback(() => {
    close();
    setCommunityOpen(true);
  }, [close]);

  const handleCloseCommunity = useCallback(() => {
    setCommunityOpen(false);
  }, []);

  // Close the drawer first so the sheet's live preview shows the terminal behind
  const handleOpenBackgroundPicker = useCallback(() => {
    close();
    setBgPickerOpen(true);
  }, [close]);

  const handleCloseBackgroundPicker = useCallback(() => {
    setBgPickerOpen(false);
  }, []);

  const overlays = (
    <>
      <CommandNotesPanel
        isOpen={commandNotesOpen}
        onClose={handleCloseCommandNotes}
      />
      <CommunityModal
        isOpen={communityOpen}
        onClose={handleCloseCommunity}
      />
      <BackgroundPickerSheet
        isOpen={bgPickerOpen}
        onClose={handleCloseBackgroundPicker}
        busRef={context.busRef}
      />
    </>
  );

  if (!isOpen) return overlays;

  if (isDesktop) {
    return (
      <>
        <SettingsDialog
          context={context}
          callbacks={callbacks}
          canInstall={canInstall}
          isInstalled={isInstalled}
          install={install}
          onClose={close}
        />
        {overlays}
      </>
    );
  }

  // Get title based on active panel
  const getTitle = () => {
    switch (activePanel) {
      case "pwa":
        return t("pwa.title");
      case "codespace":
        return t("codespace.title");
      default:
        return t("menu.title");
    }
  };

  // Show back button for sub-panels
  const showBackButton = activePanel !== "menu";

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop - more transparent to see behind */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={close}
      />

      {/* Menu Panel - slides from right */}
      <div
        className="absolute top-0 right-0 bottom-0 w-[85vw] sm:w-96 max-w-md bg-surface border-l border-border shadow-2xl flex flex-col slide-in-right pt-[var(--safe-top)] pb-[var(--safe-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            {showBackButton && (
              <button
                onClick={handleBack}
                className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors mr-1"
                aria-label={t("common.back")}
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <h2 className="text-lg font-semibold text-text">{getTitle()}</h2>
            {activePanel === "menu" && (() => {
              const isRtc = context.carrier && context.carrier !== "ws";
              return (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    isRtc
                      ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                      : "bg-yellow-500/15 text-yellow-500 border border-yellow-500/30"
                  }`}
                  title={`Carrier: ${isRtc ? `WebRTC (${context.carrier})` : "WebSocket"}`}
                >
                  {isRtc ? "RTC" : "WS"}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-1">
            {activePanel === "menu" && (
              <>
                {SHOW_GITHUB_STAR && (
                  <a
                    href={GITHUB_REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex items-center gap-1.5 text-xs font-medium"
                    title="Star on GitHub"
                    aria-label="Star on GitHub"
                  >
                    <Github size={16} />
                    <Star size={13} className="text-yellow-500 fill-yellow-500" />
                    {formattedStars && <span className="font-mono text-[11px] leading-none">{formattedStars}</span>}
                  </a>
                )}
                <button
                  onClick={() => { vibrate(); toggleTheme(); }}
                  className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
                  aria-label={t("menu.theme")}
                  title={t("menu.theme")}
                >
                  {appTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => { vibrate(); setLanguageOpen(true); }}
                  className="px-2 py-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex items-center gap-1.5 text-sm font-medium"
                  aria-label={t("menu.language")}
                  title={t("menu.language")}
                >
                  <img src={`https://flagcdn.com/w40/${currentLocale.country}.png`} alt={currentLocale.label} className="w-[17px] h-[12px] object-cover rounded-[2px]" loading="lazy" />
                  <span className="uppercase">{currentLocale.code}</span>
                </button>
              </>
            )}
            <button
              onClick={close}
              className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
              aria-label={t("common.close")}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto modal-scrollable">
          {activePanel === "menu" && (
            <MenuItems
              onRemote={context.remoteAvailable ? handleRemote : null}
              onFiles={handleFiles}
              onInstallApp={handleInstallApp}
              canInstall={canInstall}
              isInstalled={isInstalled}
              onCodespace={context.codespaceInfo?.isCodespaces ? handleCodespace : null}
              onLogout={handleLogout}
              connected={context.connected}
              remoteAvailable={context.remoteAvailable}
              codespaceInfo={context.codespaceInfo}
              showTheme={context.showTheme}
              theme={context.theme}
              onThemeChange={handleThemeChange}
              hideActions={context.hideActions || []}
              busRef={context.busRef}
              subscribeToPush={context.subscribeToPush}
              unsubscribeFromPush={context.unsubscribeFromPush}
              onUpdate={handleUpdate}
              onRestart={handleRestart}
              onOpenBackgroundPicker={handleOpenBackgroundPicker}
            />
          )}

          {activePanel === "pwa" && <PwaInstallGuide />}

          {activePanel === "codespace" && (
            <CodespacePanel
              codespaceInfo={context.codespaceInfo}
              busRef={context.busRef}
              onStop={handleStopCodespace}
            />
          )}
        </div>
      </div>

      <CommandNotesPanel
        isOpen={commandNotesOpen}
        onClose={handleCloseCommandNotes}
      />
      <CommunityModal
        isOpen={communityOpen}
        onClose={handleCloseCommunity}
      />
      <BackgroundPickerSheet
        isOpen={bgPickerOpen}
        onClose={handleCloseBackgroundPicker}
        busRef={context.busRef}
      />
      <LanguageModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
    </div>
  );
}
