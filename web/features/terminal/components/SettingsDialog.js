"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  X, ChevronLeft, Settings, Palette, Terminal, Bell, Sparkles, Globe,
  Download, RefreshCw, RotateCw, LogOut, Loader2, Monitor, Type, FolderOpen,
  GitBranch, ListChecks, Sun, Moon, Keyboard, PanelRight, ChevronRight, Zap
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { TERMINAL_THEME_OPTIONS } from "@/features/terminal/constants/themes";
import { HEADER_BUTTONS } from "@/features/terminal/constants/terminalConfig";
import { HEADER_BUTTON_ICONS } from "@/features/terminal/constants/headerButtonIcons";
import LanguageModal from "@/shared/components/ui/LanguageModal";
import { SETTINGS_CATEGORIES } from "@/features/terminal/constants/settingsCategories";
import { AGENT_LABELS } from "@/features/terminal/constants/agentLabels";
import { agentIconUrl } from "@/features/terminal/constants/agentCli";
import { SHORTCUT_ROWS, shortcutKeys, SHORTCUT_KEY_CLS } from "@/features/terminal/constants/shortcuts";
import { usePushToggle } from "@/features/terminal/hooks/usePushToggle";
import { useArtifactToggle } from "@/features/terminal/hooks/useArtifactToggle";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import CodespacePanel from "@/features/codespace/components/CodespacePanel";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";

const ICONS = { Settings, Palette, Terminal, Bell, Sparkles, Keyboard, Zap };


/**
 * SettingsDialog - desktop settings surface: centered modal, category nav on the
 * left, one scrollable pane on the right. Mobile keeps the SlideMenu drawer.
 */
export default function SettingsDialog({
  context, callbacks, canInstall, isInstalled, install,
  onSites, onClose
}) {
  const { t, locale } = useI18n();
  const { theme: appTheme, setTheme } = useTheme();
  const [section, setSection] = useState("general");
  const [reloading, setReloading] = useState(false);

  const [languageOpen, setLanguageOpen] = useState(false);
  const currentLocale = SUPPORTED_LOCALES.find((l) => l.code === locale);
  const hiddenHeaderButtons = useTerminalStore((s) => s.hiddenHeaderButtons);
  const toggleHeaderButton = useTerminalStore((s) => s.toggleHeaderButton);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const setTerminalTheme = useTerminalStore((s) => s.setTerminalTheme);
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const setShowFolderButton = useTerminalStore((s) => s.setShowFolderButton);
  const showGitButton = useTerminalStore((s) => s.showGitButton);
  const setShowGitButton = useTerminalStore((s) => s.setShowGitButton);
  const showNoteButton = useTerminalStore((s) => s.showNoteButton);
  const setShowNoteButton = useTerminalStore((s) => s.setShowNoteButton);

  const push = usePushToggle(context.subscribeToPush, context.unsubscribeFromPush);
  const artifact = useArtifactToggle(context.socketRef, context.connected);
  const mcpClients = useTerminalStore((s) => s.mcpClients);
  const artifactSupported = artifact.supported;

  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const agentVersion = context.agentVersion;
  const isOutdated = isAgentOutdated(agentVersion, webVersion) || isWebOutdated(agentVersion, webVersion);
  const isCodespaces = !!context.codespaceInfo?.isCodespaces;
  const hideActions = useMemo(() => context.hideActions || [], [context.hideActions]);
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || !!window.ReactNativeWebView
  );
  // Sites live in the session list's own header there, so the menu hides them
  const showSites = !hideActions.includes("sites") && !!onSites;
  const showInstall = !isApp && !isInstalled;

  // Codespace only inside a codespace; the terminal tab is dead on screens with no PTY.
  const categories = useMemo(() => SETTINGS_CATEGORIES.filter((c) => {
    if (c.id === "codespace") return isCodespaces;
    if (c.id === "terminal") return !hideActions.includes("terminalSettings");
    // An agent too old to serve MCP has nothing to put on this tab
    if (c.id === "mcp") return artifactSupported;
    return true;
  }), [isCodespaces, hideActions, artifactSupported]);
  // "install" is a drill-in from the install row, not a nav entry — it has no category
  const activeCategory = categories.find((c) => c.id === section);

  useEffect(() => {
    // The language modal listens on window and this listens on document, so a
    // single Escape would reach both and close the dialog underneath it. The
    // innermost layer wins: skip while a child modal is up.
    const onKey = (e) => { if (e.key === "Escape" && !languageOpen) onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, languageOpen]);

  // Actions that navigate away close the dialog first
  const run = useCallback((fn) => { vibrate(); onClose(); setTimeout(() => fn?.(), 50); }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in" onClick={onClose} />

      <div
        className="relative w-full max-w-4xl h-[85vh] max-h-[640px] bg-surface border border-border rounded-brand-lg shadow-2xl flex overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={t("menu.settings")}
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
                    active ? "bg-brand-500/15 text-brand-500" : "text-text-muted hover:bg-surface-2 hover:text-text"
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

          <div className="flex-1 overflow-y-auto modal-scrollable px-6 py-5">
            {section === "general" && (
              <div className="space-y-6">
                {(push.supported || showSites || showInstall) && (
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
                    {showSites && (
                      <ActionRow icon={Globe} label={t("menu.sites")} disabled={!context.connected} onClick={() => run(onSites)} />
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
                  {callbacks.onRestart && (
                    <ActionRow icon={RotateCw} label={t("menu.restartHost")} onClick={() => run(callbacks.onRestart)} />
                  )}
                </Group>

                {callbacks.onLogout && (
                  <Group title={t("menu.settingsAccount")}>
                    <ActionRow icon={LogOut} label={t("menu.logout")} danger onClick={() => run(callbacks.onLogout)} />
                  </Group>
                )}

                {isOutdated && <AgentOutdatedBanner agentVersion={agentVersion} webVersion={webVersion} />}
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
                    <Globe size={16} className="text-brand-500 flex-shrink-0" />
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

                <Group title={t("menu.headerButtons")}>
                  {HEADER_BUTTONS.map(({ id, labelKey }) => (
                    <ToggleRow
                      key={id}
                      icon={HEADER_BUTTON_ICONS[id]}
                      label={t(labelKey)}
                      value={!hiddenHeaderButtons.includes(id)}
                      onChange={() => toggleHeaderButton(id)}
                    />
                  ))}
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
                      className="bg-surface-2 text-text text-sm rounded-brand px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
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
                      className="bg-surface-2 text-text text-sm rounded-brand px-2 py-1 max-w-[220px] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                    >
                      <option value="default">Vesper (Default)</option>
                      {TERMINAL_THEME_OPTIONS.filter((opt) => opt.mode === appTheme).map((opt) => (
                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                      ))}
                    </select>
                  </SelectRow>
                  <ToggleRow icon={Monitor} label={t("menu.webgl")} hint={t("menu.webglHint")} value={webglEnabled} onChange={setWebglEnabled} />
                </Group>

                <Group title={t("menu.showButtons")}>
                  <ToggleRow icon={FolderOpen} label={t("menu.showFolder")} value={showFolderButton} onChange={setShowFolderButton} />
                  <ToggleRow icon={GitBranch} label={t("menu.showGit")} value={showGitButton} onChange={setShowGitButton} />
                  <ToggleRow icon={ListChecks} label={t("menu.showNote")} value={showNoteButton} onChange={setShowNoteButton} />
                </Group>
              </div>
            )}

            {section === "mcp" && (
              <div className="space-y-6">
                {/* Named by the agent, not hardcoded here: it is the side that owns each
                    CLI's config file, so it is the side that knows which ones it reaches. */}
                {mcpClients.length > 0 && (
                  <Group title={t("menu.mcpClients")}>
                    <div className="flex flex-wrap gap-1.5">
                      {mcpClients.map((id) => (
                        <span key={id} className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-brand bg-surface-2 text-[12px] text-text">
                          <img src={agentIconUrl(id)} alt="" className="w-3.5 h-3.5 rounded-[2px]" />
                          {AGENT_LABELS[id] || id}
                        </span>
                      ))}
                    </div>
                  </Group>
                )}

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
              </div>
            )}
            {section === "shortcuts" && (
              <ul className="flex flex-col">
                {SHORTCUT_ROWS.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-4 px-3 py-2.5 rounded-brand hover:bg-surface-2"
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

            {section === "codespace" && (
              <CodespacePanel
                codespaceInfo={context.codespaceInfo}
                socketRef={context.socketRef}
                onStop={() => run(callbacks.onStopCodespace)}
              />
            )}

            {section === "install" && <PwaInstallGuide />}
          </div>
        </div>
      </div>

      <LanguageModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
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
      <RowIcon size={16} className={`${danger ? "text-red-400" : "text-brand-500"} ${iconClass}`} />
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
      <RowIcon size={16} className="text-brand-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-xs text-text-muted truncate">{hint}</span>}
      </div>
      {loading ? (
        <Loader2 size={16} className="animate-spin text-text-muted" />
      ) : (
        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${value ? "bg-brand-500" : "bg-surface-2"}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
        </span>
      )}
    </button>
  );
}

function SelectRow({ icon: RowIcon, label, children }) {
  return (
    <div className="w-full px-3 py-2 rounded-brand flex items-center gap-2.5 text-sm text-text">
      <RowIcon size={16} className="text-brand-500 flex-shrink-0" />
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
        active ? "border-brand-500 bg-brand-500/10 text-brand-500" : "border-border text-text hover:bg-surface-2"
      }`}
    >
      <CardIcon size={16} />
      <span>{label}</span>
    </button>
  );
}
