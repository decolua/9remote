"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useRemoteBus } from "@/features/remote/hooks/useRemoteBus";
import { useRemoteSurface } from "@/features/remote/hooks/useRemoteSurface";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { useBenchmark } from "@/features/remote/hooks/useBenchmark";
import { useRemoteStream } from "@/features/remote/hooks/useRemoteStream";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import RemoteShell from "@/features/remote/components/RemoteShell";
import RemoteUnavailable from "@/features/remote/components/RemoteUnavailable";
import DebugPanel from "@/features/remote/components/DebugPanel";
import { debugLog } from "@/shared/utils/debugLog";
import Spinner from "@/shared/components/ui/Spinner";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { useI18n } from "@/shared/i18n";

export default function RemoteDesktop({
  onClose, busRef, protocolRef, connected, carrier, hostPlatform,
  hostLabel, remoteStatus = null, otherReadyHosts = [], onOpenHost, canvasStyle = null
}) {
  const { t } = useI18n();
  const [showConfirmExit, setShowConfirmExit] = useState(false);
  // Host refused to attach the stream (feature off / permissions gone / headless).
  // Keyed by the bus that refused, so switching hosts clears it without an effect.
  const [refusedBus, setRefusedBus] = useState(null);

  const { stats, trackTilesReceived, resetStats } = useBenchmark();
  const [showDebug, setShowDebug] = useState(REMOTE_CONFIG.debug?.panel ?? false);
  const [wsBlocked, setWsBlocked] = useState(false);
  const debugMode = REMOTE_CONFIG.enableWebRTC ? "rtc" : "ws";
  const copyStats = useCallback(() => {
    const snapshot = { mode: debugMode, ...stats, ts: new Date().toISOString() };
    navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2)).catch(() => {});
  }, [stats, debugMode]);

  // Periodic console log for benchmark comparison (copy console output to share)
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);
  useEffect(() => {
    debugLog("remote", `[stats] interval started, mode=${debugMode}`);
    const id = setInterval(() => {
      debugLog("remote", `[stats][${debugMode}]`, JSON.stringify(statsRef.current));
    }, 5000);
    return () => {
      debugLog("remote", "[stats] interval stopped");
      clearInterval(id);
    };
  }, [debugMode]);

  const emits = useRemoteBus(busRef, connected);
  const { streaming, emitRequestScreenWithHashes, emitDesktopSwitch } = emits;
  const surface = useRemoteSurface({ emits, streaming, hostPlatform });
  const { canvasRef, serverDimensionsRef, handleCanvasDimensions, resetPan, zoomGestureTimeoutRef, textInputRef, keyboardOn } = surface;

  const handleClose = useCallback(() => setShowConfirmExit(true), []);

  useEffect(() => {
    if (carrier) debugLog("remote", `[remote] carrier: ${carrier}`);
  }, [carrier]);

  const tiles = useTiles(busRef, streaming, canvasRef);

  const {
    screenLocked, unlockReady, unlockResult, setUnlockResult,
    clipboard, monitors, activeMonitorIndex, cursorShape
  } = useRemoteStream({
    busRef, connected, streaming,
    canvasRef, serverDimensionsRef, handleCanvasDimensions, resetPan,
    zoomGestureTimeoutRef, trackTilesReceived, tiles,
    onUnavailable: () => setRefusedBus(busRef)
  });

  const onSelectMonitor = useCallback((index) => {
    busRef?.current?.emit("select_monitor", { index });
  }, [busRef]);

  if (refusedBus && refusedBus === busRef) {
    return (
      <RemoteUnavailable
        hostLabel={hostLabel}
        status={remoteStatus}
        platform={hostPlatform}
        hosts={otherReadyHosts}
        onOpenHost={onOpenHost}
        onBack={onClose}
        canvasStyle={canvasStyle}
      />
    );
  }

  return (
    <>
      <RemoteShell
        surface={surface}
        canvasStyle={canvasStyle}
        connected={connected}
        clipboard={clipboard}
        hasFrame={tiles.hasFrame}
        onBack={handleClose}
        onClose={handleClose}
        onRefresh={() => emitRequestScreenWithHashes([])}
        onDesktopSwitch={emitDesktopSwitch}
        onToggleDebug={() => setShowDebug(s => !s)}
        debugOn={showDebug}
        canvasProps={{
          cursorShape,
          monitors,
          activeMonitorIndex,
          onSelectMonitor,
          screenLocked,
          unlockReady,
          unlockResult,
          onUnlockSubmit: (text) => {
            setUnlockResult(null);
            busRef?.current?.emit("desktop-unlock", { text });
          }
        }}
        // Same poster stage the session list and terminal empty state open on, so the
        // wait reads as part of the app rather than a bare spinner.
        placeholder={(
          <div className="flex-1 min-w-0 empty-stage">
            <div className="empty-icons" />
            <div className="empty-half">
              <span className="empty-idx"><b>01</b> / {t("workspaces.emptyTagRemote")}</span>
              <span className="empty-word login-hero-grad">{t("workspaces.emptyWordRemote")}</span>
              <span className="empty-meta" dangerouslySetInnerHTML={{ __html: t("workspaces.emptyMetaRemote") }} />
              <span className="empty-go">
                <Spinner size="sm" />
                {t("remote.connecting")}
              </span>
            </div>
          </div>
        )}
      />

      {showDebug && (
        <DebugPanel
          onForceWsDisconnect={() => busRef?.current?.disconnect()}
          onToggleWsBlock={() => {
            const pm = protocolRef?.current;
            if (!pm) return;
            const next = !pm.wsBlocked;
            pm.setWsBlocked(next);
            setWsBlocked(next);
          }}
          isWsBlocked={wsBlocked}
          stats={stats}
          mode={debugMode}
          onReset={resetStats}
          onCopy={copyStats}
          onClose={() => setShowDebug(false)}
        />
      )}

      <ConfirmDialog
        isOpen={showConfirmExit}
        onClose={() => {
          setShowConfirmExit(false);
          if (keyboardOn) textInputRef.current?.focus();
        }}
        onConfirm={() => onClose?.()}
        title={t("remote.exitRemote")}
        message={t("remoteControls.exitConfirmMessage")}
        confirmText={t("connection.exit")}
        cancelText={t("common.cancel")}
      />
    </>
  );
}
