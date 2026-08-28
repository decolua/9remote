"use client";

// Apps on the device: drop an APK to install, then launch / clear / remove.

import { useCallback, useRef, useState } from "react";
import { Package, Play, Trash2, Upload, Loader2, RefreshCw, Link2, Square } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

export default function AppPanel({ apps, foreground, busy, progress, error, onInstall, onLaunch, onStopApp, onClearData, onUninstall, onOpenLink, onRefresh }) {
  const { t } = useI18n();
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState("");

  const pickApk = useCallback((fileList) => {
    const file = [...(fileList || [])].find((f) => f.name.toLowerCase().endsWith(".apk"));
    if (file) onInstall?.(file);
  }, [onInstall]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    pickApk(e.dataTransfer?.files);
  }, [pickApk]);

  const installing = busy === "install";

  return (
    <div
      className="h-full overflow-y-auto modal-scrollable p-3 space-y-3"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {/* Install: the whole card is the drop target, and it is also a button —
          drag-and-drop does not exist on a phone. */}
      <button
        onClick={() => { vibrate(); fileRef.current?.click(); }}
        disabled={installing}
        className={`w-full rounded-brand-lg border border-dashed px-3 py-5 flex flex-col items-center gap-1.5 transition-colors duration-150 ${dragging ? "border-brand-500 bg-brand-500/5" : "border-border hover:border-brand-500/50"
          } disabled:opacity-60`}
      >
        {installing ? (
          <>
            <Loader2 size={20} className="text-brand-500 animate-spin" />
            <span className="text-sm text-text">{t("mobile.installing")}</span>
            {progress > 0 && (
              <div className="w-full max-w-[180px] h-1 bg-surface-2 rounded-full overflow-hidden mt-1">
                <div className="h-full bg-brand-500 transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
          </>
        ) : (
          <>
            <Upload size={20} className="text-text-muted" />
            <span className="text-sm text-text">{t("mobile.dropApk")}</span>
            <span className="text-xs text-text-muted">{t("mobile.dropApkHint")}</span>
          </>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        className="hidden"
        onChange={(e) => { pickApk(e.target.files); e.target.value = ""; }}
      />

      {/* Deep link — test a custom scheme without a terminal. */}
      <form
        onSubmit={(e) => { e.preventDefault(); if (link.trim()) { onOpenLink?.(link.trim()); setLink(""); } }}
        className="flex items-center gap-1.5"
      >
        <div className="flex-1 flex items-center gap-2 bg-surface rounded-brand px-2.5 py-1.5">
          <Link2 size={14} className="text-text-muted flex-shrink-0" />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t("mobile.deepLinkPlaceholder")}
            className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none min-w-0"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <button
          type="submit"
          disabled={!link.trim()}
          className="px-2.5 py-1.5 text-sm text-text bg-surface hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.97] disabled:opacity-40"
        >
          {t("common.open")}
        </button>
      </form>

      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs text-text-muted flex-1">{t("mobile.installedApps")}</span>
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1 text-text-muted hover:text-text rounded-brand transition-colors"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {apps.length === 0 && <p className="text-text-muted text-xs text-center py-4">{t("mobile.noApps")}</p>}

      <div className="space-y-1">
        {apps.map((app) => {
          const isForeground = foreground?.packageName === app.packageName;
          const rowBusy = busy === app.packageName;
          return (
            <div key={app.packageName} className="bg-surface rounded-brand px-2.5 py-2 flex items-center gap-2">
              <Package size={14} className={isForeground ? "text-brand-500 flex-shrink-0" : "text-text-muted flex-shrink-0"} />
              <span className="text-sm text-text truncate flex-1" title={app.packageName}>{app.packageName}</span>
              {rowBusy ? (
                <Loader2 size={14} className="text-brand-500 animate-spin flex-shrink-0" />
              ) : (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  {app.launchable && (
                    <button
                      onClick={() => { vibrate(); onLaunch?.(app.packageName); }}
                      className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-colors"
                      title={t("mobile.launch")}
                      aria-label={t("mobile.launch")}
                    >
                      <Play size={13} />
                    </button>
                  )}
                  {isForeground && (
                    <button
                      onClick={() => { vibrate(); onStopApp?.(app.packageName); }}
                      className="p-1.5 text-text-muted hover:text-amber-400 hover:bg-surface-2 rounded-brand transition-colors"
                      title={t("mobile.forceStop")}
                      aria-label={t("mobile.forceStop")}
                    >
                      <Square size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => { vibrate(); onClearData?.(app.packageName); }}
                    className="p-1.5 text-text-muted hover:text-amber-400 hover:bg-surface-2 rounded-brand transition-colors"
                    title={t("mobile.clearData")}
                    aria-label={t("mobile.clearData")}
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    onClick={() => { vibrate(); onUninstall?.(app.packageName); }}
                    className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors"
                    title={t("mobile.uninstall")}
                    aria-label={t("mobile.uninstall")}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}
