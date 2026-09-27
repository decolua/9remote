"use client";

// Device chooser. Running and stopped devices share one list: tapping a row
// opens it, booting first when it needs booting. "+" adds a device in one
// tap (the host handles every install); ⋮ on a stopped AVD deletes or wipes.

import { useState } from "react";
import { Smartphone, Monitor, Play, Square, Loader2, RefreshCw, Zap, Plus, Trash2, RotateCw, MoreVertical } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

// Past this many rows the arrival delay stops growing — the tail of a long list
// should not be left waiting for its turn.
const MAX_STAGGER = 8;

function StateDot({ state }) {
  const cls = state === "running" ? "bg-green-500 animate-pulse"
    : state === "starting" || state === "stopping" ? "bg-amber-400 animate-pulse"
      : "bg-text-muted/40";
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

// Setup steps, as plain words — the same labels the add-device modal uses.
function setupStepKey(job) {
  if (job?.step) return `mobile.provisionStep_${job.step}`;
  const c = job?.component || "";
  if (c.startsWith("system-images;")) return "mobile.provisionStep_image";
  return `mobile.provisionStep_${c}`;
}

export default function DevicePicker({
  devices, canManage, booting, stopping, loading, error, onOpen, onStop, onRefresh,
  lowPower, onLowPowerChange, onAddDevice, onDeleteAvd, onWipeAvd,
  sdkJob, onShowSetup
}) {
  const { t } = useI18n();
  const [menuFor, setMenuFor] = useState(null);       // device.id with menu open
  const [confirm, setConfirm] = useState(null);        // { kind, avdName, name }

  return (
    <div className="w-full max-w-sm mx-auto p-4 space-y-3 fade-in">
      <div className="flex items-center gap-2">
        <h2 className="text-text text-sm font-medium flex-1">{t("mobile.pickDevice")}</h2>
        <button
          onClick={() => { vibrate(); onAddDevice?.(); }}
          className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("mobile.addDevice")}
          aria-label={t("mobile.addDevice")}
        >
          <Plus size={15} />
        </button>
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("mobile.refreshDevices")}
          aria-label={t("mobile.refreshDevices")}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {/* Setup runs host-side; this banner is the way back to its progress
          after the modal was closed (or the view was left and reopened). */}
      {sdkJob && sdkJob.phase !== "done" && sdkJob.phase !== "error" && (
        <button
          onClick={() => { vibrate(); onShowSetup?.(); }}
          className="w-full flex items-center gap-2.5 bg-surface rounded-brand-lg px-3 py-2.5 hover:bg-surface-2 transition-colors text-left"
        >
          <Loader2 size={15} className="text-brand-500 animate-spin flex-shrink-0" />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-xs text-text truncate">{t(setupStepKey(sdkJob))}</span>
            <span className="text-[10px] text-text-muted">
              {sdkJob.kind === "image" || sdkJob.step === "image"
                ? `${sdkJob.percent ?? 0}%`
                : `${Math.round((sdkJob.received || 0) / 1024 / 1024)} MB${sdkJob.bytesPerSec ? ` · ${Math.round(sdkJob.bytesPerSec / 1024 / 1024)} MB/s` : ""}`}
            </span>
          </div>
        </button>
      )}

      {devices.length === 0 && (
        <div className="text-center py-8 space-y-2 fade-in">
          {loading ? (
            <Loader2 size={20} className="text-brand-500 animate-spin mx-auto" />
          ) : (
            <>
              <Smartphone size={26} className="text-text-muted mx-auto" />
              <p className="text-text-muted text-sm">{t("mobile.noDevicesHint")}</p>
            </>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        {devices.map((device, index) => {
          const isBooting = booting?.avdName && booting.avdName === device.avdName;
          const isStopping = stopping?.has(device.serial);
          const running = device.state === "running";
          return (
            <div
              key={device.id}
              className="bg-surface rounded-brand-lg overflow-hidden list-rise"
              style={{ "--i": Math.min(index, MAX_STAGGER) }}
            >
              <div className="flex items-center gap-2.5 px-3 py-2">
                <button
                  onClick={() => { vibrate(); onOpen?.(device); }}
                  disabled={isBooting || isStopping}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-60 transition-all duration-150 ease-out active:scale-[0.99]"
                >
                  {device.kind === "physical"
                    ? <Smartphone size={16} className="text-brand-500 dark:text-white flex-shrink-0" />
                    : <Monitor size={16} className="text-brand-500 dark:text-white flex-shrink-0" />}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm text-text truncate">{device.name}</span>
                    <span className="text-xs text-text-muted truncate">
                      {isBooting ? t(`mobile.phase${booting.phase.charAt(0).toUpperCase()}${booting.phase.slice(1)}`) : isStopping ? t("mobile.stoppingDevice") : (device.serial || t("mobile.stopped"))}
                    </span>
                  </div>
                  <StateDot state={isBooting || isStopping ? "starting" : device.state} />
                </button>

                {isBooting ? (
                  <Loader2 size={15} className="text-brand-500 animate-spin flex-shrink-0" />
                ) : running && device.canStop ? (
                  isStopping ? (
                    <Loader2 size={15} className="text-brand-500 animate-spin flex-shrink-0" />
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); vibrate(); onStop?.(device); }}
                      className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
                      title={t("mobile.stopDevice")}
                      aria-label={t("mobile.stopDevice")}
                    >
                      <Square size={14} />
                    </button>
                  )
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

                {/* Housekeeping on our own stopped AVDs only — a running one's
                    files are held by the emulator, and a physical phone is
                    never ours to erase. */}
                {canManage && device.kind === "emulator" && device.avdName && !running && !isBooting && (
                  <button
                    onClick={(e) => { e.stopPropagation(); vibrate(); setMenuFor(menuFor === device.id ? null : device.id); }}
                    className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
                    aria-label={t("mobile.avdMenu")}
                  >
                    <MoreVertical size={14} />
                  </button>
                )}
              </div>

              {menuFor === device.id && (
                <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border bg-surface-2/50">
                  <button
                    onClick={() => { vibrate(); setConfirm({ kind: "wipe", avdName: device.avdName, name: device.name }); setMenuFor(null); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
                  >
                    <RotateCw size={12} /> {t("mobile.avdWipe")}
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={() => { vibrate(); setConfirm({ kind: "delete", avdName: device.avdName, name: device.name }); setMenuFor(null); }}
                    className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors"
                  >
                    <Trash2 size={12} /> {t("mobile.avdDelete")}
                  </button>
                </div>
              )}
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
          <Zap size={15} className={lowPower ? "text-brand-500 dark:text-white flex-shrink-0" : "text-text-muted flex-shrink-0"} />
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm text-text">{t("mobile.lowPower")}</span>
            <span className="text-xs text-text-muted">{t("mobile.lowPowerHint")}</span>
          </div>
          <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors border border-transparent flex-shrink-0 ${lowPower ? "bg-brand-500 dark:bg-white" : "bg-surface-2 dark:border-white/15"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${lowPower ? "translate-x-4 dark:bg-dark-800" : "translate-x-0.5 dark:bg-white/50"}`} />
          </span>
        </button>
      )}

      {error && <p className="text-red-400 text-xs text-center">{error}</p>}

      <ConfirmDialog
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === "delete") onDeleteAvd?.(confirm.avdName);
          else onWipeAvd?.(confirm.avdName);
          setConfirm(null);
        }}
        title={t(confirm?.kind === "delete" ? "mobile.avdDeleteTitle" : "mobile.avdWipeTitle")}
        message={t(confirm?.kind === "delete" ? "mobile.avdDeleteMessage" : "mobile.avdWipeMessage", { name: confirm?.name || "" })}
        confirmText={t(confirm?.kind === "delete" ? "common.delete" : "mobile.avdWipe")}
      />
    </div>
  );
}
