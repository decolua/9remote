"use client";

// Device chooser. Running and stopped devices share one list: tapping a row
// opens it, booting first when it needs booting. Collapsible sections cover
// the manager side: tooling setup and system images.

import { useState } from "react";
import { Smartphone, Monitor, Play, Square, Loader2, RefreshCw, Zap, HardDrive, ChevronDown, ChevronUp, Plus, Trash2, RotateCw, MoreVertical } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import SdkSetupCard from "./SdkSetupCard";
import ImagesPanel from "./ImagesPanel";
import CreateAvdModal from "./CreateAvdModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

// Past this many rows the arrival delay stops growing — the tail of a long list
// should not be left waiting for its turn.
const MAX_STAGGER = 8;

function StateDot({ state }) {
  const cls = state === "running" ? "bg-green-500 animate-pulse"
    : state === "starting" ? "bg-amber-400 animate-pulse"
      : "bg-text-muted/40";
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

export default function DevicePicker({
  devices, canManage, booting, loading, error, onOpen, onStop, onRefresh,
  lowPower, onLowPowerChange, env, sdkJob, onInstallSdk, onCancelSdk,
  images, imagesLoading, imagesError, installedImages, hostAbi, onRefreshImages,
  onInstallImage, onUninstallImage,
  profiles, onRefreshProfiles, onCreateAvd, onDeleteAvd, onWipeAvd
}) {
  const { t } = useI18n();
  const [showImages, setShowImages] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [menuFor, setMenuFor] = useState(null);       // device.id with menu open
  const [confirm, setConfirm] = useState(null);        // { kind: "delete"|"wipe", avdName, name }

  return (
    <div className="w-full max-w-sm mx-auto p-4 space-y-3 fade-in">
      <div className="flex items-center gap-2">
        <h2 className="text-text text-sm font-medium flex-1">{t("mobile.pickDevice")}</h2>
        {canManage && (
          <button
            onClick={() => { vibrate(); onRefreshProfiles?.(); onRefreshImages?.(); setShowCreate(true); }}
            className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
            title={t("mobile.avdCreateTitle")}
            aria-label={t("mobile.avdCreateTitle")}
          >
            <Plus size={15} />
          </button>
        )}
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
          title={t("mobile.refreshDevices")}
          aria-label={t("mobile.refreshDevices")}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <SdkSetupCard
        env={env}
        sdkJob={sdkJob}
        onInstall={onInstallSdk}
        onCancel={onCancelSdk}
        onRefresh={onRefresh}
      />

      {/* Manager section — collapsed while the picker is the focus. */}
      {(env?.components?.["cmdline-tools"]?.installed || sdkJob) && (
        <div className="bg-surface rounded-brand-lg overflow-hidden">
          <button
            onClick={() => { vibrate(); setShowImages(!showImages); }}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 transition-colors text-left"
          >
            <HardDrive size={14} className="text-brand-500 flex-shrink-0" />
            <span className="text-xs text-text flex-1">{t("mobile.imagesTitle")}</span>
            {showImages ? <ChevronUp size={13} className="text-text-muted" /> : <ChevronDown size={13} className="text-text-muted" />}
          </button>
          {showImages && (
            <div className="px-2 pb-2">
              <ImagesPanel
                images={images}
                loading={imagesLoading}
                error={imagesError}
                installedPaths={new Set(installedImages)}
                job={sdkJob}
                onInstall={onInstallImage}
                onUninstall={onUninstallImage}
                onRefresh={onRefreshImages}
              />
            </div>
          )}
        </div>
      )}

      {devices.length === 0 && (
        <div className="text-center py-8 space-y-2 fade-in">
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
        {devices.map((device, index) => {
          const isBooting = booting?.avdName && booting.avdName === device.avdName;
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
                  disabled={isBooting}
                  className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:opacity-60 transition-all duration-150 ease-out active:scale-[0.99]"
                >
                  {device.kind === "physical"
                    ? <Smartphone size={16} className="text-brand-500 flex-shrink-0" />
                    : <Monitor size={16} className="text-brand-500 flex-shrink-0" />}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm text-text truncate">{device.name}</span>
                    <span className="text-xs text-text-muted truncate">
                      {isBooting ? t(`mobile.phase${booting.phase.charAt(0).toUpperCase()}${booting.phase.slice(1)}`) : (device.serial || t("mobile.stopped"))}
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

                {/* Manager menu, only where the AVD is actually ours to
                    manage — a running one must be stopped first, matching the
                    agent-side enforcement. */}
                {canManage && device.kind === "emulator" && device.avdName && !running && (
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

      <CreateAvdModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        profiles={profiles}
        images={images}
        installedImages={installedImages}
        hostAbi={hostAbi}
        loading={imagesLoading}
        onCreate={onCreateAvd}
        onRefreshImages={onRefreshImages}
      />

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
