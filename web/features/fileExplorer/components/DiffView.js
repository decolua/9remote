"use client";

import { useState, useEffect } from "react";
import { parseRepoDiffPath, isImageFile } from "../constants/fileExplorer.js";
import { useI18n } from "@/shared/i18n";
import DiffBody from "./DiffBody.js";
import ImageDiffView from "./ImageDiffView.js";

// One file's git diff, fetched then handed to DiffBody (or ImageDiffView for images).
export default function DiffView({ diffPath, workspace, fileBus, compact = false }) {
  const { t } = useI18n();
  const { status, repoPath, filePath } = parseRepoDiffPath(diffPath);
  const effectiveWorkspace = repoPath || workspace;
  const isImage = isImageFile(filePath);

  const [loading, setLoading] = useState(!isImage);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (isImage) return;
    let cancelled = false;
    // Deferred a tick so the loading flag is not set synchronously inside the effect.
    const id = setTimeout(async () => {
      setLoading(true);
      setError("");
      const r = await fileBus.gitDiff?.(effectiveWorkspace, filePath, status);
      if (cancelled) return;
      if (r?.success) setDiff(r.diff || "");
      else setError(r?.error || "");
      setLoading(false);
    }, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [effectiveWorkspace, filePath, status, fileBus, isImage]);

  if (isImage) {
    return (
      <ImageDiffView
        filePath={filePath}
        status={status}
        workspace={effectiveWorkspace}
        fileBus={fileBus}
        compact={compact}
      />
    );
  }

  return (
    <div className={`h-full overflow-auto ${compact ? "p-0" : "p-2 sm:p-3"}`}>
      {error && (
        <div className="bg-red-500/20 border border-red-500/50 rounded px-4 py-2 text-red-400 text-sm mb-3">{error}</div>
      )}
      {loading ? (
        <div className="flex items-center justify-center h-32 text-text-muted text-sm">{t("common.loading")}</div>
      ) : diff ? (
        <DiffBody diff={diff} compact={compact} />
      ) : (
        <div className="flex items-center justify-center h-32 text-text-muted text-sm">{t("git.noChanges")}</div>
      )}
    </div>
  );
}
