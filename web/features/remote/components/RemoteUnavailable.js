"use client";

import { AlertCircle, ChevronLeft, ChevronRight, Monitor } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Why remote cannot open on this host, and the one-tap way out: switch to a host
// that is ready, or follow the steps to fix this one. `status` is the host's own
// breakdown (null = an older host that only reports a boolean).
export default function RemoteUnavailable({ hostLabel, status = null, platform = null, hosts = [], onOpenHost, onBack, canvasStyle = null }) {
  const { t } = useI18n();
  const host = hostLabel || t("agentSwitcher.unnamed");
  const isMac = platform === "darwin";

  const reasons = [];
  if (!status) {
    reasons.push(t("remote.unavailableUnknown", { host }));
  } else {
    if (!status.capable) reasons.push(t("remote.unavailableNoCapture"));
    if (!status.enabled) reasons.push(t("remote.unavailableDisabled", { host }));
    if (!status.screenRecording) reasons.push(t("remote.unavailableScreenRecording", { host }));
    if (!status.accessibility) reasons.push(t("remote.unavailableAccessibility", { host }));
  }
  // The host refused at runtime (module failed to load) — status says nothing is missing.
  if (!reasons.length) reasons.push(t("remote.unavailableFailed", { host }));
  // macOS keeps TCC grants out of a running process until it restarts.
  if (isMac && status && (!status.screenRecording || !status.accessibility)) {
    reasons.push(t("remote.unavailableMacRestart"));
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg text-text" style={canvasStyle}>
      <header
        className="flex items-center gap-2 px-3 py-3 flex-shrink-0"
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        <button
          type="button"
          onClick={() => { vibrate(); onBack?.(); }}
          className="grid place-items-center w-8 h-8 rounded-brand text-text-muted hover:text-text active:scale-90 transition-all"
          aria-label={t("remote.back")}
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-sm font-semibold truncate">{t("remote.title")}</h2>
      </header>

      <div className="flex-1 overflow-auto modal-scrollable px-4 pb-[calc(24px+var(--safe-bottom))]">
        <div className="mx-auto mt-4 max-w-md card-elev rounded-2xl p-5 fade-in">
          <div className="flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-full bg-surface-2 text-text-muted flex-shrink-0">
              <Monitor size={18} />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text truncate">{t("remote.unavailableTitle")}</h3>
              <p className="text-xs text-text-muted truncate">{host}</p>
            </div>
          </div>

          <ul className="mt-4 flex flex-col gap-2.5">
            {reasons.map((reason) => (
              <li key={reason} className="flex items-start gap-2 text-[13px] leading-snug text-text-muted">
                <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-amber-500" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>

          {hosts.length > 0 && (
            <div className="mt-5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {t("remote.unavailableOtherHosts")}
              </p>
              <div className="mt-1.5 flex flex-col">
                {hosts.map((h) => (
                  <button
                    key={h.key}
                    type="button"
                    onClick={() => { vibrate(); onOpenHost?.(h.key); }}
                    className="flex items-center gap-2.5 px-1 py-2.5 text-left rounded-brand hover:bg-surface-2 active:bg-surface-2 transition-colors"
                  >
                    <Monitor size={16} className="text-text-muted flex-shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-sm text-text">{h.label || t("agentSwitcher.unnamed")}</span>
                    <ChevronRight size={16} className="text-text-muted flex-shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
