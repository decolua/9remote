"use client";

// Device chooser. Running and stopped devices share one list: tapping a row
// opens it, booting first when it needs booting.

import { Smartphone, Monitor, Play, Square, Loader2, RefreshCw, Zap } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

function StateDot({ state }) {
  const cls = state === "running" ? "bg-green-500"
    : state === "starting" ? "bg-amber-400 animate-pulse"
      : "bg-text-muted/40";
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

export default function DevicePicker({ devices, canManage, booting, loading, error, onOpen, onStop, onRefresh, lowPower, onLowPowerChange }) {
  const { t } = useI18n();

  return (
    <div className="w-full max-w-sm mx-auto p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-text text-sm font-medium flex-1">{t("mobile.pickDevice")}</h2>
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("mobile.refreshDevices")}
          aria-label={t("mobile.refreshDevices")}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {devices.length === 0 && (
        <div className="text-center py-8 space-y-2">
          {loading ? (
            <Loader2 size={20} className="text-brand-500 animate-spin mx-auto" />
          ) : (
            <>
              <Smartphone size={26} className="text-text-muted mx-auto" />
              <p className="text-text-muted text-sm">
                {canManage ? t("mobile.noDevicesWithSdk") : t("mobile.noDevices")}
              </p>
            </>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {devices.map((device) => {
          const isBooting = booting?.avdName && booting.avdName === device.avdName;
          const running = device.state === "running";
          return (
            <div key={device.id} className="bg-surface rounded-brand-lg overflow-hidden">
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button
                  onClick={() => { vibrate(); onOpen?.(device); }}
                  disabled={isBooting}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-60 transition-all duration-150 ease-out active:scale-[0.99]"
                >
                  {device.kind === "physical"
                    ? <Smartphone size={16} className="text-brand-500 flex-shrink-0" />
                    : <Monitor size={16} className="text-brand-500 flex-shrink-0" />}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm text-text truncate">{device.name}</span>
                    <span className="text-xs text-text-muted truncate">
                      {isBooting ? t(`mobile.phase.${booting.phase}`) : (device.serial || t("mobile.stopped"))}
                    </span>
                  </div>
                  <StateDot state={isBooting ? "starting" : device.state} />
                </button>

                {isBooting ? (
                  <Loader2 size={15} className="text-brand-500 animate-spin flex-shrink-0" />
                ) : running && device.canStop ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); onStop?.(device); }}
                    className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
                    title={t("mobile.stopDevice")}
                    aria-label={t("mobile.stopDevice")}
                  >
                    <Square size={14} />
                  </button>
                ) : !running ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); onOpen?.(device); }}
                    className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
                    title={t("mobile.startDevice")}
                    aria-label={t("mobile.startDevice")}
                  >
                    <Play size={14} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Only offered where it applies: it is a launch flag, so it changes
          nothing for a device already running or plugged in over USB. */}
      {canManage && devices.some((d) => d.state !== "running") && (
        <button
          onClick={() => { vibrate(); onLowPowerChange?.(!lowPower); }}
          className="w-full bg-surface rounded-brand-lg px-3 py-2 flex items-center gap-2.5 text-left hover:bg-surface-2 transition-colors"
        >
          <Zap size={15} className={lowPower ? "text-brand-500 flex-shrink-0" : "text-text-muted flex-shrink-0"} />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm text-text">{t("mobile.lowPower")}</span>
            <span className="text-xs text-text-muted">{t("mobile.lowPowerHint")}</span>
          </div>
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${lowPower ? "bg-brand-500" : "bg-surface-2"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${lowPower ? "translate-x-4" : "translate-x-0.5"}`} />
          </span>
        </button>
      )}

      {error && <p className="text-red-400 text-xs text-center">{error}</p>}
    </div>
  );
}
