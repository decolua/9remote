"use client";

// Setup card: shows the host's Android tooling state (adb / emulator) with an
// install button per missing component. Everything here requires an explicit
// click — nothing downloads on its own.

import { Download, Check, Loader2, HardDrive, AlertCircle, RefreshCw } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function StateRow({ state }) {
  const cls = state === "installed" ? "text-green-500"
    : state === "installing" ? "text-brand-500"
      : state === "error" ? "text-red-400"
        : "text-text-muted";
  const Icon = state === "installed" ? Check
    : state === "installing" ? Loader2
      : state === "error" ? AlertCircle
        : Download;
  return <Icon size={15} className={`${cls} flex-shrink-0 ${state === "installing" ? "animate-spin" : ""}`} />;
}

export default function SdkSetupCard({ env, sdkJob, onInstall, onCancel, onRefresh }) {
  const { t } = useI18n();
  // Install order: a component whose prerequisites are missing shows why
  // instead of offering a button that fails at download time.
  const depLabel = (name) => ({
    "platform-tools": "adb",
    "cmdline-tools": t("mobile.setupDepsCmdline"),
    "jdk": t("mobile.setupDepsJdk"),
    "emulator": t("mobile.setupDepsEmulator")
  }[name] || name);

  if (!env) return null;

  const components = env.components || {};
  const job = sdkJob && sdkJob.phase !== "done" && sdkJob.phase !== "error" ? sdkJob : null;
  // A user-cancelled job is not a failure — it shows as a plain missing row again.
  const jobError = sdkJob?.phase === "error" && sdkJob.error !== "cancelled" ? sdkJob : null;
  // Nothing missing and nothing happening — stay out of the way.
  const visible = job || jobError || Object.values(components).some((c) => !c.installed);
  if (!visible) return null;

  const diskFree = env.diskFree;

  return (
    <div className="bg-surface rounded-brand-lg p-3 space-y-2.5 list-rise">
      <div className="flex items-center gap-2">
        <HardDrive size={14} className="text-brand-500 flex-shrink-0" />
        <span className="text-xs text-text font-medium flex-1">{t("mobile.setupTitle")}</span>
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
          title={t("mobile.refreshDevices")}
          aria-label={t("mobile.refreshDevices")}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {Object.entries(components).map(([name, comp]) => {
        const isJob = job?.component === name;
        const state = isJob ? "installing"
          : jobError?.component === name ? "error"
            : comp.installed ? "installed" : "missing";
        return (
          <div key={name} className="flex items-center gap-2.5">
            <StateRow state={state} />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-xs text-text truncate">{name}</span>
              {isJob && job.phase === "downloading" && job.kind !== "image" && (
                <span className="text-[10px] text-text-muted">
                  {fmtBytes(job.received)}{job.total ? ` / ${fmtBytes(job.total)}` : ""}
                  {job.bytesPerSec ? ` · ${fmtBytes(job.bytesPerSec)}/s` : ""}
                </span>
              )}
              {isJob && job.phase === "downloading" && job.kind === "image" && (
                <span className="text-[10px] text-text-muted">{job.percent ?? 0}%</span>
              )}
              {isJob && job.phase === "extracting" && (
                <span className="text-[10px] text-text-muted">{t("mobile.setupExtracting")}</span>
              )}
              {jobError?.component === name && (
                <span className="text-[10px] text-red-400 truncate" title={jobError.error}>{jobError.error}</span>
              )}
            </div>
            {comp.installed ? null : isJob ? (
              <button
                onClick={() => { vibrate(); onCancel?.(); }}
                className="px-2 py-0.5 text-[11px] text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
              >
                {t("common.cancel")}
              </button>
            ) : (comp.missingRequires?.length ? (
              <span className="px-2 py-0.5 text-[10px] text-text-muted flex-shrink-0">
                {t("mobile.setupRequires", { deps: comp.missingRequires.map(depLabel).join(", ") })}
              </span>
            ) : (
              <button
                onClick={() => { vibrate(); onInstall?.(name); }}
                disabled={!!job}
                className="px-2 py-0.5 text-[11px] text-brand-500 hover:bg-brand-500/10 rounded-brand transition-colors disabled:opacity-40 flex-shrink-0"
              >
                {t("mobile.setupInstall")}
              </button>
            ))}
          </div>
        );
      })}

      {diskFree != null && (
        <p className="text-[10px] text-text-muted truncate">
          {t("mobile.setupInstallTo")}: {env.installRoot} · {fmtBytes(diskFree)}
        </p>
      )}
    </div>
  );
}
