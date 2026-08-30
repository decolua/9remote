"use client";

// System image manager: browse the sdkmanager catalog, install what an AVD
// will boot, and remove what is no longer needed. Readable labels — the raw
// package path is secondary.

import { useState } from "react";
import { Download, Check, Loader2, Trash2, ChevronDown, ChevronRight, Search, X, RefreshCw } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

// android-35 → API 35; ext/PS16k/tablet variants are noise the label drops.
function parseImage(imagePath) {
  const [, api, variant, abi] = imagePath.split(";");
  const apiNum = Number(String(api || "").replace("android-", "")) || null;
  const variantLabel = String(variant || "")
    .replace(/_playstore$/, " (Play)")
    .replace("google_apis_playstore", "Google Play")
    .replace("google_apis", "Google APIs")
    .replace("default", "AOSP")
    .replace("aosp_atd", "AOSP (automated test)")
    .replace("google_atd", "Google (automated test)");
  return { api: apiNum, variant: variantLabel, abi };
}

function imageLabel(imagePath) {
  const { api, variant } = parseImage(imagePath);
  return `Android ${api ?? "?"} — ${variant}`;
}

export default function ImagesPanel({ images, loading, error, installedPaths, job, onInstall, onUninstall, onRefresh }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);   // imagePath

  const filtered = images.filter((img) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return img.path.toLowerCase().includes(q);
  });

  // Group by API level so the list reads like Studio's SDK Manager: releases
  // collapsed by default, the chosen one open.
  const byApi = new Map();
  for (const img of filtered) {
    const { api } = parseImage(img.path);
    if (!byApi.has(api)) byApi.set(api, []);
    byApi.get(api).push(img);
  }
  const apis = [...byApi.keys()].filter((a) => a != null).sort((a, b) => b - a);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 px-1 pb-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-surface-2 rounded-brand px-2 py-1">
          <Search size={13} className="text-text-muted flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("mobile.imagesSearch")}
            className="bg-transparent text-xs text-text placeholder-text-muted outline-none w-full"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-text-muted hover:text-text">
              <X size={12} />
            </button>
          )}
        </div>
        <button
          onClick={() => { vibrate(); onRefresh?.(); }}
          className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
          aria-label={t("common.refresh")}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable space-y-1">
        {error && <p className="text-red-400 text-xs px-1 py-2">{error}</p>}
        {!loading && !error && apis.length === 0 && (
          <p className="text-text-muted text-xs px-1 py-4 text-center">{t("mobile.imagesNone")}</p>
        )}
        {apis.map((api) => (
          <div key={api} className="bg-surface rounded-brand-lg overflow-hidden">
            <button
              onClick={() => { vibrate(); setExpanded(expanded === api ? null : api); }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-2 transition-colors text-left"
            >
              {expanded === api ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
              <span className="text-xs text-text font-medium flex-1">Android {api}</span>
              <span className="text-[10px] text-text-muted">{byApi.get(api).length}</span>
            </button>
            {expanded === api && (
              <div className="px-3 pb-2 space-y-1">
                {byApi.get(api).map((img) => {
                  const installed = installedPaths?.has(img.path);
                  const installing = job?.kind === "image" && job.component === img.path && job.phase !== "done" && job.phase !== "error";
                  return (
                    <div key={img.path} className="flex items-center gap-2 py-1">
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs text-text truncate">{parseImage(img.path).variant}</span>
                        <span className="text-[10px] text-text-muted truncate">{img.path}</span>
                      </div>
                      {installing ? (
                        <span className="text-[10px] text-brand-500 flex-shrink-0">{job.percent ?? 0}%</span>
                      ) : installed ? (
                        <button
                          onClick={() => { vibrate(); setConfirmDelete(img.path); }}
                          className="p-1.5 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
                          title={t("mobile.imageRemove")}
                          aria-label={t("mobile.imageRemove")}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : (
                        <button
                          onClick={() => { vibrate(); onInstall?.(img.path); }}
                          disabled={!!job}
                          className="p-1.5 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-40 flex-shrink-0"
                          title={t("mobile.imageInstall")}
                          aria-label={t("mobile.imageInstall")}
                        >
                          <Download size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { onUninstall?.(confirmDelete); setConfirmDelete(null); }}
        title={t("mobile.imageRemoveTitle")}
        message={t("mobile.imageRemoveMessage", { path: imageLabel(confirmDelete || "") })}
        confirmText={t("common.delete")}
      />
    </div>
  );
}
