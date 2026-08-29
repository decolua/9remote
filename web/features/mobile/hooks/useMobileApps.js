"use client";

// App management for the active device: install by drop, launch, clear, remove.

import { useCallback, useEffect, useState } from "react";
import { uploadFiles } from "@/features/fileExplorer/lib/fileTransfer";
import { emitAck } from "./useMobileDevices";

export function useMobileApps({ busRef, protocolRef, serial, enabled }) {
  const [apps, setApps] = useState([]);
  const [foreground, setForeground] = useState(null);
  const [busy, setBusy] = useState(null);      // packageName | "install"
  const [progress, setProgress] = useState(0); // 0..1 while uploading
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!serial || !enabled) return;
    const res = await emitAck(busRef?.current, "mobile:apps", { serial });
    if (!res?.success) return;
    setApps(res.apps || []);
    setForeground(res.foreground || null);
  }, [busRef, serial, enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const act = useCallback(async (event, packageName, after) => {
    setBusy(packageName);
    setError(null);
    const res = await emitAck(busRef?.current, event, { serial, packageName });
    setBusy(null);
    if (!res?.success) { setError(res?.error || "Failed"); return false; }
    if (after) await refresh();
    return true;
  }, [busRef, serial, refresh]);

  const launch = useCallback((pkg) => act("mobile:launch", pkg), [act]);
  const stopApp = useCallback((pkg) => act("mobile:stopApp", pkg), [act]);
  const clearData = useCallback((pkg) => act("mobile:clearApp", pkg), [act]);
  const uninstall = useCallback((pkg) => act("mobile:uninstall", pkg, true), [act]);

  /**
   * Install an APK the user dropped. The bytes ride the existing file-upload
   * pipeline into a staging dir, then the agent installs and deletes them.
   */
  const install = useCallback(async (file) => {
    if (!file || !serial) return;
    setBusy("install");
    setError(null);
    setProgress(0);
    try {
      const stage = await emitAck(busRef?.current, "mobile:apkStage", { name: file.name, size: file.size });
      if (!stage?.success) throw new Error(stage?.error || "Cannot stage APK");

      let uploadError = null;
      await uploadFiles({
        bus: busRef?.current,
        protocolRef,
        targetDir: stage.targetDir,
        items: [{ file, relativePath: stage.fileName }],
        callbacks: {
          onProgress: (_f, sent, total) => setProgress(total ? sent / total : 0),
          onError: (_f, e) => { uploadError = e; }
        }
      });
      if (uploadError) throw uploadError;

      const res = await emitAck(busRef?.current, "mobile:install", {
        serial,
        fileName: stage.fileName,
        launch: true
      });
      if (!res?.success) throw new Error(res?.error || "Install failed");
      await refresh();
      return res.packageName;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
      setProgress(0);
    }
  }, [busRef, protocolRef, serial, refresh]);

  const openLink = useCallback(async (url) => {
    setError(null);
    const res = await emitAck(busRef?.current, "mobile:openLink", { serial, url });
    if (!res?.success) setError(res?.error || "Could not open link");
    return res?.success;
  }, [busRef, serial]);

  return { apps, foreground, busy, progress, error, setError, refresh, install, launch, stopApp, clearData, uninstall, openLink };
}
