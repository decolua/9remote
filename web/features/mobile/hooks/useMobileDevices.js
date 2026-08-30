"use client";

// Device list + emulator lifecycle. One list holds both powered-off AVDs and
// live devices, so "start it" and "use it" are the same row.

import { useCallback, useEffect, useState } from "react";
import { DEVICE_REFRESH_MS } from "../constants/mobileConfig";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export function emitAck(bus, event, payload) {
  return new Promise((resolve) => {
    if (!bus) { resolve({ success: false, error: "Not connected" }); return; }
    bus.emit(event, payload, (res) => resolve(res || { success: false, error: "No response" }));
  });
}

export function useMobileDevices({ busRef, connected }) {
  const [devices, setDevices] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [booting, setBooting] = useState(null);   // { avdName, phase }
  const [error, setError] = useState(null);
  // Rendered (empty list vs. not asked yet), so it has to be state, not a ref.
  const [loaded, setLoaded] = useState(false);
  // Live setup/download job { component, step, phase, received, total, … }.
  // Null between jobs; survives panel close because the job runs on the agent.
  const [sdkJob, setSdkJob] = useState(null);
  const lowPower = useTerminalStore((s) => s.mobileLowPower);
  const setLowPower = useTerminalStore((s) => s.setMobileLowPower);

  const refresh = useCallback(async () => {
    const bus = busRef?.current;
    if (!bus || !connected) return [];
    const res = await emitAck(bus, "mobile:list", {});
    if (!res?.success) return [];
    setLoaded(true);
    setCanManage(!!res.canManageEmulators);
    if (res.env) {
      // The job lives on the agent; a null here means it is gone (agent restart
      // or settled) — the UI must not keep showing a stale spinner.
      setSdkJob(res.env.job || null);
    }
    const list = Array.isArray(res.devices) ? res.devices : [];
    setDevices(list);
    return list;
  }, [busRef, connected]);

  // Boot progress arrives as events — the ack only lands when boot finishes.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onProgress = ({ avdName, phase }) => setBooting({ avdName, phase });
    bus.on("mobile:avdProgress", onProgress);
    // Setup/download progress; refresh() re-syncs the settled state.
    const onSdkProgress = (job) => {
      setSdkJob(job);
      if (job.phase === "done" || job.phase === "error") refresh();
    };
    bus.on("mobile:sdkProgress", onSdkProgress);
    return () => {
      bus.off("mobile:avdProgress", onProgress);
      bus.off("mobile:sdkProgress", onSdkProgress);
    };
  }, [busRef, connected, refresh]);

  // Poll so a device plugged in (or an emulator started elsewhere) shows up.
  useEffect(() => {
    if (!connected) return;
    refresh();
    const id = setInterval(refresh, DEVICE_REFRESH_MS);
    return () => clearInterval(id);
  }, [connected, refresh]);

  /** Boot an AVD; resolves with its serial once Android is actually usable. */
  const startAvd = useCallback(async (avdName) => {
    setError(null);
    setBooting({ avdName, phase: "launching" });
    const res = await emitAck(busRef?.current, "mobile:avdStart", { avdName, lowPower });
    setBooting(null);
    await refresh();
    if (!res?.success) { setError(res?.error || "Could not start"); return null; }
    return res.serial;
  }, [busRef, refresh, lowPower]);

  const stopAvd = useCallback(async (serial) => {
    setError(null);
    const res = await emitAck(busRef?.current, "mobile:avdStop", { serial });
    await refresh();
    if (!res?.success) setError(res?.error || "Could not stop");
    return res?.success;
  }, [busRef, refresh]);

  // ── One-tap provisioning ────────────────────────────────────────────────────

  const [presets, setPresets] = useState([]);

  const refreshPresets = useCallback(async () => {
    const res = await emitAck(busRef?.current, "mobile:provisionPresets", {});
    if (res?.success) setPresets(Array.isArray(res.presets) ? res.presets : []);
  }, [busRef]);

  /** Tap a device row → agent installs what's missing and creates the AVD. */
  const provision = useCallback(async (presetId) => {
    setError(null);
    const res = await emitAck(busRef?.current, "mobile:provision", { presetId });
    await Promise.all([refresh(), refreshPresets()]);
    if (!res?.success) { setError(res?.error || "Could not create device"); return false; }
    return true;
  }, [busRef, refresh, refreshPresets]);

  const cancelSetup = useCallback(async () => {
    await emitAck(busRef?.current, "mobile:sdkCancel", {});
    await refresh();
  }, [busRef, refresh]);

  const deleteAvd = useCallback(async (avdName) => {
    const res = await emitAck(busRef?.current, "mobile:avdDelete", { avdName });
    if (!res?.success) setError(res?.error || "Could not delete");
    await refresh();
    return res?.success;
  }, [busRef, refresh]);

  const wipeAvd = useCallback(async (avdName) => {
    const res = await emitAck(busRef?.current, "mobile:avdWipe", { avdName });
    if (!res?.success) setError(res?.error || "Could not wipe");
    await refresh();
    return res?.success;
  }, [busRef, refresh]);

  return {
    devices, canManage, booting, error, setError,
    refresh, startAvd, stopAvd,
    lowPower, setLowPower,
    sdkJob, presets, refreshPresets, provision, cancelSetup, deleteAvd, wipeAvd,
    // Distinguishes "still asking the agent" from "asked, and there are none".
    loaded
  };
}
