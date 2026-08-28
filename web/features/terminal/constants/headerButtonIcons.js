// Icons for the header-button toggles, shared by the desktop settings screen and
// the mobile slide menu. Separate from terminalConfig.js so that file stays free
// of component imports — it is loaded by the store, which must not pull in React
// components.
import { Monitor, Smartphone, Globe, Bell } from "@/shared/components/ui/Icon";

export const HEADER_BUTTON_ICONS = {
  remote: Monitor,
  mobile: Smartphone,
  sites: Globe,
  notifications: Bell
};
