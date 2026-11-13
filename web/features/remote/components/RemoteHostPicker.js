"use client";

import { ChevronRight, Monitor } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// The phone dock's Remote tab asks which host to mirror when more than one can
// serve it; picking a row hands its key to the caller's remoteHead.
const PLATFORM_LABEL = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export default function RemoteHostPicker({ hosts = [], onPick, onClose }) {
  const { t } = useI18n();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center scrim fade-in"
      onClick={onClose}
    >
      <div
        className="card-elev w-full sm:max-w-sm max-h-[70%] flex flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl sheet-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="sm:hidden mx-auto mt-2.5 h-1 w-9 rounded-full bg-text-subtle/40" aria-hidden="true" />
        <h2 className="px-5 pt-3 pb-2 text-base font-semibold text-text">{t("remote.title")}</h2>
        <div
          className="px-2 overflow-auto modal-scrollable"
          style={{ paddingBottom: "max(0.5rem, var(--safe-bottom))" }}
        >
          {hosts.map((h) => {
            const subtitle = [PLATFORM_LABEL[h.platform], t("hosts.online")].filter(Boolean).join(" · ");
            return (
              <button
                key={h.key}
                onClick={() => { vibrate(); onPick?.(h.key); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-2xl hover:bg-surface-2 active:bg-surface-2 transition-colors"
              >
                <span className="relative grid place-items-center w-10 h-10 rounded-xl bg-surface-2 text-text-muted shrink-0">
                  <Monitor size={18} />
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-surface-2" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-text truncate">{h.label || t("agentSwitcher.unnamed")}</span>
                  <span className="block text-[11px] text-text-muted truncate">{subtitle}</span>
                </span>
                <ChevronRight size={16} className="text-text-subtle shrink-0" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
