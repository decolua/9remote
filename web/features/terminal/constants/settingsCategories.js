// Desktop settings dialog nav — order and labels live here, not in the component.
import { JARVIS_ENABLED } from "@/shared/lib/jarvisConstants";

export const SETTINGS_CATEGORIES = [
  { id: "general", labelKey: "menu.settingsGeneral", icon: "Settings" },
  { id: "appearance", labelKey: "menu.settingsAppearance", icon: "Palette" },
  { id: "terminal", labelKey: "menu.settingsTerminalTab", icon: "Terminal" },
  { id: "background", labelKey: "menu.terminalBackground", icon: "Image" },
  { id: "buttons", labelKey: "menu.settingsButtons", icon: "PanelRight" },
  { id: "mcp", labelKey: "menu.settingsMcp", icon: "Zap" },
  // Agent-env only (filtered in SettingsDialog): machine-local settings the
  // agent's own origin can serve.
  { id: "agent", labelKey: "menu.settingsAgent", icon: "Monitor" },
  ...(JARVIS_ENABLED ? [{ id: "jarvis", labelKey: "menu.settingsJarvis", icon: "Bot" }] : []),
  { id: "shortcuts", labelKey: "shortcuts.menuLabel", icon: "Keyboard" },
];
