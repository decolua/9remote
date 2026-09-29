// Desktop settings dialog nav — order and labels live here, not in the component.
import { JARVIS_ENABLED } from "@/shared/lib/jarvisConstants";

export const SETTINGS_CATEGORIES = [
  { id: "general", labelKey: "menu.settingsGeneral", icon: "Settings" },
  // Host-env only (filtered in SettingsDialog): machine lifecycle settings the
  // host's own origin can serve. Sits right after General so, with General
  // hidden in host-env, it leads the nav — matching the default open section.
  { id: "system", labelKey: "menu.settingsSystem", icon: "Monitor" },
  { id: "appearance", labelKey: "menu.settingsAppearance", icon: "Palette" },
  { id: "terminal", labelKey: "menu.settingsTerminalTab", icon: "Terminal" },
  { id: "background", labelKey: "menu.terminalBackground", icon: "Image" },
  { id: "voice", labelKey: "menu.settingsVoice", icon: "Mic" },
  { id: "browser", labelKey: "menu.settingsBrowser", icon: "Globe" },
  { id: "mcp", labelKey: "menu.settingsMcp", icon: "Zap" },
  ...(JARVIS_ENABLED ? [{ id: "jarvis", labelKey: "menu.settingsJarvis", icon: "Bot" }] : []),
  { id: "debug", labelKey: "menu.settingsDebug", icon: "Bug" },
  { id: "shortcuts", labelKey: "shortcuts.menuLabel", icon: "Keyboard" },
];
