"use client";

// Android device view: pick a device (booting it if needed), then mirror it.
//
// Layout is screen + a single control rail on the right. Everything that is not
// the device screen lives in that rail — navigation keys, and the apps and log
// panels, which slide over the screen rather than living behind tabs.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Smartphone, Loader2, Keyboard, Triangle, Circle, Square, Power, RotateCw, Package, FileText, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useMobileDevices, emitAck } from "../hooks/useMobileDevices";
import { useMobileSession } from "../hooks/useMobileSession";
import { useMobileStream, DECODER_SUPPORTED } from "../hooks/useMobileStream";
import { useMobileInput } from "../hooks/useMobileInput";
import { useMobileApps } from "../hooks/useMobileApps";
import { useMobileLogcat } from "../hooks/useMobileLogcat";
import DevicePicker from "./DevicePicker";
import AppPanel from "./AppPanel";
import LogcatPanel from "./LogcatPanel";

export default function MobileMirror({ onClose, socketRef, protocolRef, connected, variant = "fullscreen" }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const keyboardInputRef = useRef(null);
  // Which overlay is up over the screen, if any. Null is the plain mirror.
  const [overlay, setOverlay] = useState(null);   // "apps" | "logs" | null
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [rotation, setRotation] = useState(0);

  const deviceApi = useMobileDevices({ socketRef, connected });
  const { devices, canManage, booting, refresh, startAvd, stopAvd, lowPower, setLowPower } = deviceApi;

  const session = useMobileSession({ socketRef, connected, devices, startAvd });
  const { serial, meta, starting, error: sessionError, open, stop } = session;

  const { status } = useMobileStream({ socketRef, connected, canvasRef, meta });
  const input = useMobileInput({ socketRef, canvasRef });
  const apps = useMobileApps({ socketRef, protocolRef, serial, enabled: !!meta });
  const logcat = useMobileLogcat({
    socketRef, serial,
    active: !!meta && overlay === "logs",
    foregroundPackage: apps.foreground?.packageName
  });

  // The canvas backing store is the encoded size; CSS letterboxes it to fit.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) return;
    canvas.width = meta.width;
    canvas.height = meta.height;
  }, [meta]);

  const isPanel = variant === "panel";

  const handleStop = useCallback(async (device) => {
    if (device.serial === serial) stop();
    await stopAvd(device.serial);
  }, [serial, stop, stopAvd]);

  const toggleKeyboard = useCallback(() => {
    vibrate();
    setKeyboardOn((on) => {
      if (!on) setTimeout(() => keyboardInputRef.current?.focus(), 0);
      else keyboardInputRef.current?.blur();
      return !on;
    });
  }, []);

  const rotate = useCallback(async () => {
    vibrate();
    const next = (rotation + 1) % 4;
    const res = await emitAck(socketRef?.current, "mobile:rotate", { serial, rotation: next });
    if (res?.success) setRotation(res.rotation);
  }, [rotation, serial, socketRef]);

  // Leaving the full-screen view ends the session; the desktop dock keeps it
  // alive instead, because moving the mirror is not the same as closing it.
  const handleClose = useCallback(() => {
    if (!isPanel) stop();
    onClose?.();
  }, [isPanel, stop, onClose]);

  const phaseLabel = (phase) => t(`mobile.phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`);

  // No device open yet → the picker IS the screen.
  if (!meta) {
    return (
      <div className="absolute inset-0 flex flex-col bg-bg">
        {!isPanel && (
          <header className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
            <button
              onClick={() => { vibrate(); handleClose(); }}
              className="p-1.5 text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
              aria-label={t("common.back")}
            >
              <ChevronLeft size={18} />
            </button>
            <Smartphone size={16} className="text-brand-500 flex-shrink-0" />
            <span className="text-sm text-text truncate">{t("mobile.title")}</span>
          </header>
        )}
        <div className="flex-1 overflow-y-auto modal-scrollable flex items-center justify-center">
          {starting || booting ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <Loader2 size={22} className="text-brand-500 animate-spin" />
              <p className="text-text text-sm">{booting ? phaseLabel(booting.phase) : t("mobile.starting")}</p>
              {booting && <p className="text-text-muted text-xs">{booting.avdName}</p>}
            </div>
          ) : !DECODER_SUPPORTED ? (
            <p className="text-text-muted text-sm max-w-xs text-center p-6">{t("mobile.unsupportedBrowser")}</p>
          ) : (
            <DevicePicker
              devices={devices}
              canManage={canManage}
              booting={booting}
              loading={!deviceApi.loaded}
              error={sessionError || deviceApi.error}
              onOpen={open}
              onStop={handleStop}
              onRefresh={refresh}
              lowPower={lowPower}
              onLowPowerChange={setLowPower}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex bg-bg">
      {/* Screen. The canvas stays mounted under any overlay: unmounting it would
          tear down the decoder and cost a full re-sync on every panel open. */}
      <div className="flex-1 min-w-0 relative flex items-center justify-center bg-black">
        <canvas
          ref={canvasRef}
          onPointerDown={input.onPointerDown}
          onPointerMove={input.onPointerMove}
          onPointerUp={input.onPointerUp}
          onPointerCancel={input.onPointerCancel}
          onWheel={input.onWheel}
          className="max-w-full max-h-full object-contain touch-none"
        />
        {status !== "streaming" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 size={22} className="text-brand-500 animate-spin" />
          </div>
        )}

        {/* The strip of device screen left showing doubles as a dismiss target,
            the way a bottom sheet's backdrop does. Only mounted while an overlay
            is up, so it never swallows a tap meant for the device. */}
        {overlay && (
          <button
            onClick={() => { vibrate(); setOverlay(null); }}
            className="absolute inset-x-0 top-0 h-16 z-10 cursor-pointer"
            aria-label={t("mobile.backToScreen")}
          />
        )}

        {/* Apps and logs cover the lower part of the screen rather than all of
            it: a full-bleed panel with no header read as a navigation, leaving
            no visible way back to the device. The strip of screen left showing,
            plus the titled header, keep it legible as a layer over the mirror. */}
        {overlay && (
          <div className="absolute inset-x-0 bottom-0 top-16 bg-bg border-t border-border flex flex-col shadow-[0_-8px_24px_rgba(0,0,0,0.35)] animate-in slide-in-from-bottom duration-200">
            <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border flex-shrink-0">
              {overlay === "apps"
                ? <Package size={14} className="text-brand-500 flex-shrink-0" />
                : <FileText size={14} className="text-brand-500 flex-shrink-0" />}
              <span className="text-xs text-text flex-1 truncate">
                {t(overlay === "apps" ? "mobile.tabApps" : "mobile.tabLogs")}
              </span>
              <button
                onClick={() => { vibrate(); setOverlay(null); }}
                className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
                title={t("mobile.backToScreen")}
                aria-label={t("mobile.backToScreen")}
              >
                <X size={14} />
              </button>
            </div>
            {overlay === "apps"
              ? (
                <AppPanel
                  apps={apps.apps}
                  foreground={apps.foreground}
                  busy={apps.busy}
                  progress={apps.progress}
                  error={apps.error}
                  onInstall={apps.install}
                  onLaunch={apps.launch}
                  onStopApp={apps.stopApp}
                  onClearData={apps.clearData}
                  onUninstall={apps.uninstall}
                  onOpenLink={apps.openLink}
                  onRefresh={apps.refresh}
                />
              )
              : <LogcatPanel logcat={logcat} apps={apps.apps} />}
          </div>
        )}
      </div>

      {/* Control rail. One column for everything that is not the screen, so the
          mirror keeps its full height and nothing sits above or below it. */}
      <div className="flex flex-col items-center gap-0.5 px-1 py-1.5 pb-safe border-l border-border flex-shrink-0 overflow-y-auto modal-scrollable">
        <RailButton icon={<Triangle size={15} className="-rotate-90" />} label={t("mobile.back")} onClick={() => input.sendKey("back")} />
        <RailButton icon={<Circle size={15} />} label={t("mobile.home")} onClick={() => input.sendKey("home")} />
        <RailButton icon={<Square size={14} />} label={t("mobile.recents")} onClick={() => input.sendKey("recents")} />

        <div className="w-5 h-px bg-border my-1" />

        <RailButton icon={<RotateCw size={15} />} label={t("mobile.rotate")} onClick={rotate} />
        <RailButton icon={<Keyboard size={15} />} label={t("mobile.keyboard")} onClick={toggleKeyboard} active={keyboardOn} />
        <RailButton icon={<Power size={15} />} label={t("mobile.power")} onClick={() => input.sendKey("power")} />

        <div className="w-5 h-px bg-border my-1" />

        <RailButton
          icon={<Package size={15} />}
          label={t("mobile.tabApps")}
          onClick={() => setOverlay(overlay === "apps" ? null : "apps")}
          active={overlay === "apps"}
        />
        <RailButton
          icon={<FileText size={15} />}
          label={t("mobile.tabLogs")}
          onClick={() => setOverlay(overlay === "logs" ? null : "logs")}
          active={overlay === "logs"}
        />

        {/* Pushed to the bottom: leaving the device is the rail's last resort,
            not something to hit while reaching for the nav keys. */}
        <div className="flex-1 min-h-2" />
        <RailButton icon={<Smartphone size={15} />} label={t("mobile.switchDevice")} onClick={stop} />
        {!isPanel && <RailButton icon={<X size={15} />} label={t("common.close")} onClick={handleClose} />}
      </div>

      {/* Off-screen field: the soft keyboard only opens for a focused input,
          and its keystrokes are forwarded rather than inserted. */}
      {keyboardOn && (
        <input
          ref={keyboardInputRef}
          onKeyDown={input.onKeyDown}
          onBlur={() => setKeyboardOn(false)}
          value=""
          onChange={() => { }}
          className="absolute opacity-0 pointer-events-none w-px h-px"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-hidden
        />
      )}
    </div>
  );
}

function RailButton({ icon, label, onClick, active = false }) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 ${active ? "text-brand-500 bg-surface-2" : "text-text hover:bg-surface-2"
        }`}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {icon}
    </button>
  );
}
