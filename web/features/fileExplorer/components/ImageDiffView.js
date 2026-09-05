"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDims(img) {
  const w = img?.originalWidth || img?.width;
  const h = img?.originalHeight || img?.height;
  return w && h ? `${w} × ${h}` : "";
}

function ImageCard({ title, badge, badgeColor, img, loading, error, t }) {
  const metaText = [formatDims(img), formatSize(img?.size || img?.originalSize)].filter(Boolean).join(" · ");

  return (
    <div className="flex-1 flex flex-col rounded-brand border border-border-subtle bg-surface overflow-hidden min-h-[220px]">
      <div className="px-3 py-2 border-b border-border-subtle flex items-center justify-between bg-surface-2/60 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text">{title}</span>
          {badge && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px] ${badgeColor}`}>
              {badge}
            </span>
          )}
        </div>
        {metaText && <span className="text-[11px] text-text-muted font-mono">{metaText}</span>}
      </div>

      <div className="flex-1 p-3 flex items-center justify-center bg-surface-2/20 min-h-[160px] overflow-hidden relative">
        {loading ? (
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Loader2 size={16} className="animate-spin" />
            <span>{t("common.loading")}</span>
          </div>
        ) : error ? (
          <div className="text-xs text-text-muted text-center px-4 py-6">{error}</div>
        ) : img?.dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img.dataUrl}
            alt={title}
            className="max-h-[320px] max-w-full object-contain rounded drop-shadow-sm select-none"
          />
        ) : (
          <div className="text-xs text-text-muted">{t("git.noChanges")}</div>
        )}
      </div>
    </div>
  );
}

// Side-by-side (desktop) or stacked (mobile) git diff viewer for image files.
export default function ImageDiffView({ filePath, status, workspace, fileBus, compact = false }) {
  const { t } = useI18n();

  const isAdded = status === "A" || status === "?";
  const isDeleted = status === "D";
  const hasOld = !isAdded;
  const hasNew = !isDeleted;

  const [oldImg, setOldImg] = useState(null);
  const [oldLoading, setOldLoading] = useState(hasOld);
  const [oldError, setOldError] = useState("");

  const [newImg, setNewImg] = useState(null);
  const [newLoading, setNewLoading] = useState(hasNew);
  const [newError, setNewError] = useState("");

  const [lastPath, setLastPath] = useState(filePath);
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setOldImg(null);
    setOldLoading(hasOld);
    setOldError("");
    setNewImg(null);
    setNewLoading(hasNew);
    setNewError("");
  }

  useEffect(() => {
    let cancelled = false;
    if (!filePath || !fileBus) return;

    const fullPath = workspace && !filePath.startsWith("/") ? `${workspace}/${filePath}` : filePath;
    const relFile = workspace && filePath.startsWith(workspace)
      ? filePath.slice(workspace.length).replace(/^\//, "")
      : filePath;

    const id = setTimeout(() => {
      if (hasOld) {
        setOldLoading(true);
        setOldError("");
        fileBus.gitShowMedia?.(workspace, relFile, "HEAD").then((r) => {
          if (cancelled) return;
          setOldLoading(false);
          if (r?.success) setOldImg(r);
          else setOldError(r?.error || t("git.noOldVersion", { defaultValue: "No previous version in HEAD" }));
        }).catch((e) => {
          if (cancelled) return;
          setOldLoading(false);
          setOldError(e?.message || "Failed to load old version");
        });
      }

      if (hasNew) {
        setNewLoading(true);
        setNewError("");
        fileBus.readMedia?.(fullPath).then((r) => {
          if (cancelled) return;
          setNewLoading(false);
          if (r?.success) setNewImg(r);
          else setNewError(r?.error || t("git.noNewVersion", { defaultValue: "Failed to load working image" }));
        }).catch((e) => {
          if (cancelled) return;
          setNewLoading(false);
          setNewError(e?.message || "Failed to load new version");
        });
      }
    }, 0);

    return () => { cancelled = true; clearTimeout(id); };
  }, [filePath, workspace, fileBus, hasOld, hasNew, t]);

  const fileName = filePath ? filePath.split("/").pop() : "";
  // Only show old card if it loaded successfully (or file was deleted); if unavailable, show new image only.
  const showOldCard = isDeleted || (hasOld && !oldError && (oldLoading || !!oldImg?.dataUrl));
  const showBoth = showOldCard && hasNew;

  return (
    <div className="h-full overflow-y-auto p-2 sm:p-3 flex flex-col gap-3">
      {/* Diff comparison area */}
      <div className={`flex-1 ${!compact && showBoth ? "grid grid-cols-1 md:grid-cols-2 gap-3" : "flex flex-col gap-3"}`}>
        {showOldCard && (
          <ImageCard
            title={isDeleted ? `${fileName} (Deleted)` : "Old (HEAD)"}
            badge={isDeleted ? "DELETED" : "ORIGINAL"}
            badgeColor="bg-red-500/15 text-red-400"
            img={oldImg}
            loading={oldLoading}
            error={oldError}
            t={t}
          />
        )}
        {hasNew && (
          <ImageCard
            title={isAdded ? `${fileName} (Added)` : "New (Working Tree)"}
            badge={isAdded ? "NEW" : "MODIFIED"}
            badgeColor="bg-green-500/15 text-green-400"
            img={newImg}
            loading={newLoading}
            error={newError}
            t={t}
          />
        )}
      </div>
    </div>
  );
}
