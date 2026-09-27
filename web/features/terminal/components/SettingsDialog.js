"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  X, ChevronLeft, Settings, Palette, Terminal, Bell, Sparkles, Globe,
  Download, RefreshCw, RotateCw, LogOut, Loader2, Monitor, Type,
  Sun, Moon, Keyboard, PanelRight, ChevronRight, Zap, Image, Bot,
  Power, PowerOff, Lock, FileText
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { TERMINAL_THEME_OPTIONS } from "@/features/terminal/constants/themes";
import { BUTTON_GROUPS } from "@/features/terminal/constants/terminalConfig";
import { BUTTON_TOGGLE_ICONS } from "@/features/terminal/constants/headerButtonIcons";
import { useButtonToggles } from "@/features/terminal/hooks/useButtonToggles";
import LanguageModal from "@/shared/components/ui/LanguageModal";
import { SETTINGS_CATEGORIES } from "@/features/terminal/constants/settingsCategories";
import VoiceEndpointSettings from "@/shared/components/ui/VoiceEndpointSettings";
import { SHORTCUT_ROWS, shortcutKeys, SHORTCUT_KEY_CLS } from "@/features/terminal/constants/shortcuts";
import { usePushToggle } from "@/features/terminal/hooks/usePushToggle";
import { useArtifactToggle } from "@/features/terminal/hooks/useArtifactToggle";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";
import BackgroundPickerSheet from "@/features/terminal/components/BackgroundPickerSheet";
import { JarvisConfigPanel } from "@/features/jarvis/components/JarvisConfigPanel";
import { useJarvisStore } from "@/shared/stores/jarvisStore";
import { JARVIS_ENABLED } from "@/shared/lib/jarvisConstants";
import { useAgentLocalSettings } from "@/features/terminal/hooks/useAgentLocalSettings";
import { isAgentEnvironment } from "@/shared/utils/localOrigin";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

const ICONS = { Settings, Palette, Terminal, Bell, Sparkles, Keyboard, Zap, PanelRight, Image, Bot, Monitor };


/**
 * SettingsDialog - desktop settings surface: centered modal, category nav on the
 * left, one scrollable pane on the right. Mobile keeps the SlideMenu drawer.
 */
export default function SettingsDialog({
  context, callbacks, canInstall, isInstalled, install,
  onClose
}) {
  const { t, locale } = useI18n();
  const { theme: appTheme, setTheme } = useTheme();
  // The dialog mounts only after the desktop check (post-mount), so the env
  // probe is stable here — no SSR/hydration split to worry about.
  const agentEnv = isAgentEnvironment();
  const [section, setSection] = useState(agentEnv ? "agent" : "general");
  const [reloading, setReloading] = useState(false);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const agentLocal = useAgentLocalSettings();

  const [languageOpen, setLanguageOpen] = useState(false);
  const currentLocale = SUPPORTED_LOCALES.find((l) => l.code === locale);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const setTerminalTheme = useTerminalStore((s) => s.setTerminalTheme);
  const buttonToggles = useButtonToggles();

  const push = usePushToggle(context.subscribeToPush, context.unsubscribeFromPush);
  const artifact = useArtifactToggle(context.busRef, context.connected);
  // Local (per-device) switch — no agent round-trip, so it works even offline.
  const jarvisEnabled = useJarvisStore((s) => JARVIS_ENABLED && s.settings.enabled);
  const artifactSupported = artifact.supported;
  // Plugins tab is not gated on MCP support: it also hosts the client-side voice config.

  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const agentVersion = context.agentVersion;
  const hideActions = useMemo(() => context.hideActions || [], [context.hideActions]);
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || !!window.ReactNativeWebView
  );
  const showInstall = !isApp && !isInstalled;

  const categories = useMemo(() => SETTINGS_CATEGORIES.filter((c) => {
    if (c.id === "codespace") return false;
    if (c.id === "terminal") return !hideActions.includes("terminalSettings");
    // Agent-env only tab; General is client-web only (push/install/logout are
    // meaningless on the origin the agent itself serves).
    if (c.id === "agent") return agentEnv;
    if (c.id === "general") return !agentEnv;
    return true;
  }), [hideActions, agentEnv]);
  // "install" is a drill-in from the install row, not a nav entry — it has no category
  const activeCategory = categories.find((c) => c.id === section);

  useEffect(() => {
    document.activeElement?.blur?.();
    // The language modal listens on window and this listens on document, so a
    // single Escape would reach both and close the dialog underneath it. The
    // innermost layer wins: skip while a child modal is up.
    const onKey = (e) => {
      if (e.key === "Escape" && !languageOpen && !confirmShutdown) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = "";
    };
  }, [onClose, languageOpen, confirmShutdown]);

  // Actions that navigate away close the dialog first
  const run = useCallback((fn) => { vibrate(); onClose(); setTimeout(() => fn?.(), 50); }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in" onClick={onClose} />

      <div
        className="relative w-full max-w-4xl h-[85vh] max-h-[640px] card-elev flex overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={t("menu.settings")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Category nav */}
        <nav className="w-52 flex-shrink-0 bg-bg/40 border-r border-border flex flex-col">
          <div className="h-12 flex items-center px-4 border-b border-border">
            <h2 className="text-base font-semibold text-text">{t("menu.settings")}</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5 modal-scrollable">
            {categories.map((cat) => {
              const CatIcon = ICONS[cat.icon];
              const active = section === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => { vibrate(); setSection(cat.id); }}
                  className={`w-full px-3 py-2 rounded-brand text-left flex items-center gap-2.5 text-sm transition-colors ${
                    active ? "bg-brand-500/15 text-brand-500 dark:bg-white/10 dark:text-white" : "text-text-muted hover:bg-surface-2 hover:text-text"
                  }`}
                >
                  <CatIcon size={16} />
                  <span>{t(cat.labelKey)}</span>
                </button>
              );
            })}
          </div>
          <div className="px-4 py-3 border-t border-border flex items-center gap-2">
            {context.connectionMode === "local" && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">LAN</span>
            )}
            <p className="text-text-muted text-xs truncate">
              {webVersion}{agentVersion ? ` / ${agentVersion}` : ""}
            </p>
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="h-12 flex items-center justify-between gap-2 pl-6 pr-3 border-b border-border">
            {section === "install" ? (
              <button
                onClick={() => { vibrate(); setSection("general"); }}
                className="-ml-2 px-2 py-1 text-sm font-medium text-text hover:bg-surface-2 rounded-brand transition-colors flex items-center gap-1.5"
              >
                <ChevronLeft size={16} />
                {t("pwa.title")}
              </button>
            ) : (
              <h3 className="text-sm font-medium text-text truncate">{t(activeCategory?.labelKey || "menu.settings")}</h3>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
              aria-label={t("common.close")}
            >
              <X size={18} />
            </button>
          </div>

          <div className={`flex-1 overflow-y-auto modal-scrollable px-6 ${section === "background" ? "py-4" : "py-5"}`}>
            {section === "background" && <BackgroundPickerSheet inline busRef={context.busRef} />}
            {section === "general" && (
              <div className="space-y-6">
                {(push.supported || showInstall) && (
                  <Group>
                    {push.supported && (
                      <ToggleRow
                        icon={Bell}
                        label={t("menu.notifications")}
                        hint={t("menu.notificationsHint")}
                        value={push.enabled}
                        loading={push.loading}
                        onChange={push.toggle}
                      />
                    )}
                    {showInstall && (
                      <ActionRow
                        icon={Download}
                        label={t("menu.installApp")}
                        badge={canInstall ? t("pwaGuide.installNow") : null}
                        onClick={() => (canInstall ? run(install) : setSection("install"))}
                      />
                    )}
                  </Group>
                )}

                <Group title={t("menu.reloadRestart")}>
                  <ActionRow
                    icon={RefreshCw}
                    iconClass={reloading ? "animate-spin" : ""}
                    label={t("menu.reload")}
                    disabled={reloading}
                    onClick={() => { vibrate(); setReloading(true); setTimeout(() => window.location.reload(), 150); }}
                  />
                </Group>

                {callbacks.onLogout && (
                  <Group title={t("menu.settingsAccount")}>
                    <ActionRow icon={LogOut} label={t("menu.logout")} danger onClick={() => run(callbacks.onLogout)} />
                  </Group>
                )}
              </div>
            )}

            {section === "appearance" && (
              <div className="space-y-6">
                <Group title={t("menu.theme")}>
                  <div className="grid grid-cols-2 gap-2">
                    <ThemeCard icon={Sun} label={t("menu.themeLight")} active={appTheme === "light"} onClick={() => { vibrate(); setTheme("light"); }} />
                    <ThemeCard icon={Moon} label={t("menu.themeDark")} active={appTheme === "dark"} onClick={() => { vibrate(); setTheme("dark"); }} />
                  </div>
                </Group>

                {/* One row rather than a 24-cell grid: the list is long, and
                    picking a language is rare enough that it does not deserve
                    to dominate this screen. */}
                <Group title={t("menu.language")}>
                  <button
                    onClick={() => { vibrate(); setLanguageOpen(true); }}
                    className="w-full px-3 py-2 rounded-brand text-left flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors"
                  >
                    <Globe size={16} className="text-brand-500 dark:text-white flex-shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{t("menu.language")}</span>
                    {currentLocale && (
                      <span className="flex items-center gap-1.5 flex-shrink-0 text-text-muted">
                        <img
                          src={`https://flagcdn.com/w40/${currentLocale.country}.png`}
                          alt=""
                          className="w-[17px] h-[12px] object-cover rounded-[2px]"
                          loading="lazy"
                        />
                        <span className="text-xs">{currentLocale.label}</span>
                      </span>
                    )}
                    <ChevronRight size={15} className="text-text-muted flex-shrink-0" />
                  </button>
                </Group>

             </div>
            )}

            {section === "terminal" && (
              <div className="space-y-6">
                <Group title={t("menu.terminalSettings")}>
                  <SelectRow icon={Type} label={t("menu.fontSize")}>
                    <select
                      value={fontSize ?? 14}
                      onChange={(e) => { vibrate(); setFontSize(Number(e.target.value)); }}
                      className="bg-surface-2 text-text text-sm rounded-brand px-2 py-1 focus:outline-none"
                    >
                      {Array.from({ length: 9 }, (_, i) => i + 10).map((n) => (
                        <option key={n} value={n}>{n}px</option>
                      ))}
                    </select>
                  </SelectRow>
                  <SelectRow icon={Palette} label={t("menu.terminalTheme")}>
                    <select
                      value={terminalTheme}
                      onChange={(e) => { vibrate(); setTerminalTheme(e.target.value); }}
                      className="bg-surface-2 text-text text-sm rounded-brand px-2 py-1 max-w-[220px] focus:outline-none"
                    >
                      <option value="default">Vesper (Default)</option>
                      {TERMINAL_THEME_OPTIONS.filter((opt) => opt.mode === appTheme).map((opt) => (
                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                      ))}
                    </select>
                  </SelectRow>
                  <ToggleRow icon={Monitor} label={t("menu.webgl")} hint={t("menu.webglHint")} value={webglEnabled} onChange={setWebglEnabled} />
                </Group>
              </div>
            )}

            {section === "buttons" && (
              <div className="space-y-6">
                {BUTTON_GROUPS.map(({ group, titleKey }) => (
                  <Group key={group} title={t(titleKey)}>
                    {buttonToggles.buttons.filter((b) => b.group === group).map((btn) => (
                      <ToggleRow
                        key={btn.id}
                        icon={BUTTON_TOGGLE_ICONS[btn.id]}
                        label={t(btn.labelKey)}
                        value={buttonToggles.isOn(btn)}
                        onChange={() => buttonToggles.toggle(btn)}
                      />
                    ))}
                  </Group>
                ))}
              </div>
            )}

            {section === "mcp" && (
              <div className="space-y-6">
                <VoiceEndpointSettings />

                {artifactSupported && (<>
                  {/* One switch, and the hint under it says what it buys them — MCP is
                      jargon, so the row has to explain itself. */}
                  <ToggleRow
                    icon={PanelRight}
                    label={t("menu.artifactPanel")}
                    hint={t("menu.artifactHint")}
                    value={artifact.enabled}
                    loading={artifact.loading}
                    disabled={!context.connected}
                    onChange={artifact.toggle}
                  />

                  <p className="text-[11px] leading-relaxed text-text-muted">{t("menu.mcpRestartHint")}</p>
                </>)}
              </div>
            )}

            {section === "agent" && (
              <div className="space-y-6">
                <Group title={t("menu.agentSystem")}>
                  <ToggleRow
                    icon={Power}
                    label={t("menu.agentAutoStart")}
                    hint={t("menu.agentAutoStartHint")}
                    value={!!agentLocal.autoStart}
                    loading={agentLocal.autoStart === null}
                    onChange={agentLocal.toggleAutoStart}
                  />
                  {agentLocal.unlock?.supported && (
                    <ToggleRow
                      icon={Lock}
                      label={t("menu.agentUnlock")}
                      hint={agentLocal.unlock.stale
                        ? t("menu.agentUnlockStale")
                        : agentLocal.unlock.enabled
                          ? t("menu.agentUnlockReady")
                          : t("menu.agentUnlockHint")}
                      value={!!agentLocal.unlock.enabled}
                      disabled={!!agentLocal.unlock.busy}
                      onChange={agentLocal.toggleUnlock}
                    />
                  )}
                </Group>

                <Group title={t("menu.agentLogs")}>
                  <ActionRow
                    icon={FileText}
                    label={t("menu.agentLogsOpen")}
                    // Open inside the click — a deferred window.open loses user
                    // activation and popup blockers eat it.
                    onClick={() => { vibrate(); window.open("/logs", "_blank"); onClose(); }}
                  />
                </Group>

                <Group title={t("menu.agentPower")}>
                  <ActionRow
                    icon={RefreshCw}
                    iconClass={reloading ? "animate-spin" : ""}
                    label={t("menu.reload")}
                    disabled={reloading}
                    onClick={() => { vibrate(); setReloading(true); setTimeout(() => window.location.reload(), 150); }}
                  />
                  <ActionRow
                    icon={RotateCw}
                    label={t("menu.agentRestart")}
                    onClick={() => run(agentLocal.stopAgent)}
                  />
                  <ActionRow
                    icon={PowerOff}
                    label={t("menu.agentShutdown")}
                    danger
                    onClick={() => setConfirmShutdown(true)}
                  />
                </Group>
              </div>
            )}

            {section === "jarvis" && (
              <div className="space-y-6">
                <ToggleRow
                  icon={Bot}
                  label={t("menu.jarvisToggle")}
                  hint={t("menu.jarvisToggleHint")}
                  value={jarvisEnabled}
                  onChange={(v) => {
                    useJarvisStore.getState().setSettings({ enabled: v });
                    // Toggling off mid-session must not leave the overlay stranded.
                    if (!v) useJarvisStore.getState().setOpen(false);
                  }}
                />
                {artifactSupported && !artifact.enabled && (
                  <p className="text-[11px] leading-relaxed text-amber-400">{t("menu.jarvisMcpOff")}</p>
                )}
                <JarvisConfigPanel busRef={context.busRef} />
              </div>
            )}
            {section === "shortcuts" && (
              <ul className="flex flex-col divide-y divide-border-subtle/40">
                {SHORTCUT_ROWS.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-4 px-3 py-2 rounded-brand hover:bg-surface-2 first:pt-1"
                  >
                    <span className="text-sm text-text min-w-0 truncate">{t(`shortcuts.${entry.id}`)}</span>
                    <span className="inline-flex items-center gap-1 flex-shrink-0">
                      {shortcutKeys(entry).map((key) => (
                        <kbd key={key} className={SHORTCUT_KEY_CLS}>{key}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {section === "install" && <PwaInstallGuide />}
          </div>
        </div>
      </div>

      <LanguageModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
      <ConfirmDialog
        isOpen={confirmShutdown}
        onClose={() => setConfirmShutdown(false)}
        onConfirm={() => { setConfirmShutdown(false); run(agentLocal.shutdownAgent); }}
        title={t("menu.agentShutdownConfirmTitle")}
        message={t("menu.agentShutdownConfirmMsg")}
      />
    </div>
  );
}

function Group({ title, children }) {
  return (
    <section>
      {title && <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">{title}</h4>}
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function ActionRow({ icon: RowIcon, iconClass = "", label, badge, danger, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-3 py-2 rounded-brand text-left flex items-center gap-2.5 text-sm transition-colors ${
        disabled
          ? "text-text-muted cursor-not-allowed opacity-60"
          : danger
          ? "text-text hover:bg-red-500/15 hover:text-red-400"
          : "text-text hover:bg-surface-2"
      }`}
    >
      <RowIcon size={16} className={`${danger ? "text-red-400" : "text-brand-500 dark:text-white"} ${iconClass}`} />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {badge && <span className="flex-shrink-0 px-2 py-0.5 bg-brand-500 text-white text-xs font-medium rounded-full">{badge}</span>}
    </button>
  );
}

function ToggleRow({ icon: RowIcon, label, hint, value, loading, disabled, onChange }) {
  return (
    <button
      onClick={() => { vibrate(); onChange(!value); }}
      disabled={loading || disabled}
      className="w-full px-3 py-2 rounded-brand text-left flex items-center gap-2.5 text-sm text-text hover:bg-surface-2 transition-colors disabled:opacity-60"
    >
      <RowIcon size={16} className="text-brand-500 dark:text-white flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-xs text-text-muted truncate">{hint}</span>}
      </div>
      {loading ? (
        <Loader2 size={16} className="animate-spin text-text-muted" />
      ) : (
        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border border-transparent flex-shrink-0 ${value ? "bg-brand-500 dark:bg-white" : "bg-surface-2 dark:border-white/15"}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? "translate-x-4 dark:bg-dark-800" : "translate-x-0.5 dark:bg-white/50"}`} />
        </span>
      )}
    </button>
  );
}

function SelectRow({ icon: RowIcon, label, children }) {
  return (
    <div className="w-full px-3 py-2 rounded-brand flex items-center gap-2.5 text-sm text-text">
      <RowIcon size={16} className="text-brand-500 dark:text-white flex-shrink-0" />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {children}
    </div>
  );
}

function ThemeCard({ icon: CardIcon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-3 rounded-brand flex items-center gap-2.5 text-sm border transition-colors ${
        active ? "border-brand-500 bg-brand-500/10 text-brand-500 dark:border-white/30 dark:bg-white/10 dark:text-white" : "border-border text-text hover:bg-surface-2"
      }`}
    >
      <CardIcon size={16} />
      <span>{label}</span>
    </button>
  );
}
