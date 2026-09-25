"use client";

import { Monitor, Smartphone, Globe } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { useSitesModalStore } from "@/shared/stores/sitesModalStore";

// Mobile-only cluster in the pane's top strip — title or pinned checklist,
// whichever holds the slot. These three leave the terminal for another screen;
// the header carries them on desktop, but its right-hand cluster is out of thumb
// reach on a phone, so the pane owns them here instead.
export default function PaneStripButtons({ onOpenRemote, onOpenMobile }) {
  const { t } = useI18n();
  const hiddenHeaderButtons = useTerminalStore((s) => s.hiddenHeaderButtons);
  const mobileDeviceCount = useFleetStore((s) => s.hosts[s.currentKey]?.mobileDeviceCount) || 0;
  const showButton = (id) => !hiddenHeaderButtons.includes(id);
  const openSites = useSitesModalStore((s) => s.open);

  // Same shape as the header's own buttons (Settings and friends), overflowing the
  // 26px strip so the tap area matches too — this row reads as a continuation of it.
  const cls = "p-1.5 -my-1 text-text hover:bg-surface-2 hover:text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0";

  return (
    <div
      className="flex items-center gap-2 flex-shrink-0"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {showButton("remote") && onOpenRemote && (
        <button onClick={() => { vibrate(); onOpenRemote(); }} className={cls} title={t("menu.remoteDesktop")}>
          <Monitor size={16} />
        </button>
      )}
      {showButton("mobile") && onOpenMobile && (
        <button
          onClick={() => { vibrate(); onOpenMobile(); }}
          className={`${cls} ${mobileDeviceCount > 0 ? "!text-green-400" : ""}`}
          title={mobileDeviceCount > 0
            ? t("mobile.deviceRunning", { count: mobileDeviceCount })
            : t("mobile.androidDevice")}
        >
          <Smartphone size={16} />
        </button>
      )}
      {showButton("sites") && (
        <button onClick={() => { vibrate(); openSites(); }} className={cls} title={t("menu.sites")}>
          <Globe size={16} />
        </button>
      )}
    </div>
  );
}
