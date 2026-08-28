// Icons for the button-visibility toggles, shared by the desktop settings screen
// and the mobile slide menu. Separate from terminalConfig.js so that file stays
// free of component imports — it is loaded by the store, which must not pull in
// React components.
import { Monitor, Smartphone, Globe, Bell, FolderOpen, ListChecks } from "@/shared/components/ui/Icon";

export const BUTTON_TOGGLE_ICONS = {
  remote: Monitor,
  mobile: Smartphone,
  sites: Globe,
  notifications: Bell,
  folder: FolderOpen,
  note: ListChecks
};
