"use client";

import { ListChecks, Monitor, Settings } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

/**
 * Floating pill nav for the phone's session list — the same shape 9love's tab bar has:
 * a small frosted plate hovering above the content, not a full-width bar welded to the
 * bottom edge. Three doors — the ones the list header used to carry — with the active
 * tab lifted and tinted the way 9love's dock does it.
 *
 * It owns no state and no route: every slot is a callback the caller already had in its
 * header. That is why this component can live in the list screen and disappear with it.
 */
// View type -> which dock slot is lit. Kept next to the component so a new dock tab
// is added in one place, not in every caller's ternary.
export const DOCK_TAB_OF = { list: "sessions", remote: "remote", settings: "menu" };

export default function BottomNav({
  active = "sessions",
  onSessions = null,
  onRemote = null,
  onMenu = null
}) {
  const { t } = useI18n();

  const slot = (key, icon, label, onClick, disabled = false) => {
    const Icon = icon;
    const isActive = key === active;
    return (
      <button
        key={key}
        type="button"
        onClick={() => { if (disabled) return; vibrate(); onClick?.(); }}
        disabled={disabled}
        className={`relative flex min-w-[68px] flex-col items-center gap-0.5 px-1.5 py-1 text-center text-[10px] font-medium transition-all duration-300 active:scale-90 disabled:opacity-40 ${
          isActive ? "nav-tab-on -translate-y-0.5 font-bold text-[var(--nav-accent)]" : "text-text-muted hover:text-[var(--nav-accent)]"
        }`}
        title={label}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
      >
        <span className="grid place-items-center">
          <Icon size={21} />
        </span>
        <span className="whitespace-nowrap capitalize">{label}</span>
      </button>
    );
  };

  return (
    <nav
      className="glass-bar dock-rise fixed inset-x-0 bottom-[calc(12px_+_var(--safe-bottom))] z-40 mx-auto flex h-[54px] w-fit max-w-[calc(100vw-24px)] items-center justify-center gap-1 rounded-full px-4"
      aria-label={t("sessions.headerTitle")}
    >
      {slot("sessions", ListChecks, t("hosts.sessions"), onSessions)}
      {slot("remote", Monitor, t("menu.remoteDesktop"), onRemote, !onRemote)}
      {slot("menu", Settings, t("menu.settings"), onMenu)}
    </nav>
  );
}
