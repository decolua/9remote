"use client";

import { useEffect, useCallback, useState } from "react";
import { ChevronLeft, Github, Star } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import MenuItems from "@/features/terminal/components/MenuItems";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import CommandNotesPanel from "@/features/terminal/components/CommandNotes/CommandNotesPanel";
import CommunityModal from "@/features/terminal/components/CommunityModal";
import LanguageModal from "@/shared/components/ui/LanguageModal";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import SettingsDialog from "@/features/terminal/components/SettingsDialog";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import TabPanel from "@/shared/components/ui/TabPanel";
import BackgroundPickerSheet from "@/features/terminal/components/BackgroundPickerSheet";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";
import { useGithubStars } from "@/shared/hooks/useGithubStars";
import { GITHUB_REPO_URL, SHOW_GITHUB_STAR } from "@/shared/constants/github";

/**
 * SlideMenu - Global full-screen menu that slides from right to left
 * Uses Zustand store for state management
 */
export default function SlideMenu() {
  const { t } = useI18n();
  const { formattedStars } = useGithubStars();
  // On a phone the screen IS the tab, and a tab is visible when it is the TOP view.
  // Reading the stack ROOT kept it painted over any screen opened from it (Remote
  // opened from Settings sat behind this full-screen panel and looked missing).
  const onSettingsRoute = useTerminalStore((s) => {
    const top = s.viewStack[s.viewStack.length - 1];
    return top?.type === "settings";
  });
  const storeOpen = useSlideMenuStore((s) => s.isOpen);
  const isOpen = storeOpen || onSettingsRoute;
  const tabDir = useTerminalStore((s) => s.navDir);
  const activePanel = useSlideMenuStore((s) => s.activePanel);
  const context = useSlideMenuStore((s) => s.context);
  const callbacks = useSlideMenuStore((s) => s.callbacks);
  const storeCarrier = useConnectionStore((s) => s.carrier);
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

  if (isDesktop && !isOpen) return overlays;

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
      case "menu":
        return t("menu.settings");
      default:
        return t("menu.title");
    }
  };

  // Show back button for sub-panels
  const showBackButton = activePanel !== "menu";

  return (
    // The wrapper never eats a tap: the screen it holds is pointer-events-none while
    // its tab is not the active one, and every panel below portals out to <body>.
    <div className="fixed inset-0 z-30 flex pointer-events-none">
      {/* One of the dock's tabs, not a drawer and not a pushed screen. TabPanel owns
          the switch motion and the inert/pointer handling; this is only the surface. */}
      <TabPanel active={isOpen} dir={tabDir} className="bg-bg z-30">
        <div className="flex h-full w-full flex-col pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
        {/* Header: title + carrier status, the way 9love's settings screen has nothing
            but its title. Theme and language moved into the Preferences card. */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {showBackButton && (
              <button
                onClick={handleBack}
                className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors mr-1"
                aria-label={t("common.back")}
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <h2 className="text-[26px] font-bold tracking-[-0.4px] text-text truncate">{getTitle()}</h2>
          </div>
          {/* 9love's settings header is a title and nothing else — the theme and
              language toggles are rows in the Preferences card. The carrier badge is
              the one exception: it is status, not an action, and lives nowhere else. */}
          {activePanel === "menu" && (() => {
            const liveCarrier = storeCarrier || context.carrier;
            const isRtc = liveCarrier && liveCarrier !== "ws";
            return (
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  isRtc
                    ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                    : "bg-yellow-500/15 text-yellow-500 border border-yellow-500/30"
                }`}
                title={`Carrier: ${isRtc ? `WebRTC (${liveCarrier})` : "WebSocket"}`}
              >
                {isRtc ? "RTC" : "WS"}
              </span>
            );
          })()}
        </div>

        {/* Content - scrollable */}
        {/* Bottom padding clears the dock: the tab bar floats over this screen the way
            it floats over the list. */}
        <div className="flex-1 overflow-y-auto modal-scrollable px-1 pt-1 pb-[78px]">
          {activePanel === "menu" && (
            <MenuItems
              onRemote={context.remoteAvailable ? handleRemote : null}
              onFiles={handleFiles}
              onInstallApp={handleInstallApp}
              canInstall={canInstall}
              isInstalled={isInstalled}
              onLogout={handleLogout}
              connected={context.connected}
              remoteAvailable={context.remoteAvailable}
              showTheme={context.showTheme}
              theme={context.theme}
              onThemeChange={handleThemeChange}
              hideActions={context.hideActions || []}
              busRef={context.busRef}
              subscribeToPush={context.subscribeToPush}
              unsubscribeFromPush={context.unsubscribeFromPush}
              onOpenBackgroundPicker={handleOpenBackgroundPicker}
              onOpenLanguage={() => setLanguageOpen(true)}
            />
          )}

          {activePanel === "pwa" && <PwaInstallGuide />}

        </div>

        {/* GitHub star chip - pinned footer, owns the bottom safe inset */}
        {activePanel === "menu" && SHOW_GITHUB_STAR && (
          <div className="flex-shrink-0 flex justify-center px-3 pt-2">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={vibrate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface hover:bg-surface-2 border border-border text-xs text-text-muted hover:text-text transition-colors"
              title="Star on GitHub"
              aria-label="Star on GitHub"
            >
              <Github size={14} />
              <span>{t("menu.starChip")}</span>
              <Star size={12} className="text-yellow-500 fill-yellow-500" />
              {formattedStars && <span className="font-mono text-[11px]">{formattedStars}</span>}
            </a>
          </div>
        )}
        </div>
      </TabPanel>

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
