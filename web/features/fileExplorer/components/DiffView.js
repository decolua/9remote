"use client";

import { useState, useEffect } from "react";
import { parseDiffPath } from "../constants/fileExplorer.js";
import { useI18n } from "@/shared/i18n";
import DiffBody from "./DiffBody.js";

// One file's git diff, fetched then handed to DiffBody. The git panel renders a
// whole-repo diff through the same body, so both look identical.
export default function DiffView({ diffPath, workspace, fileBus, compact = false }) {
  const { t } = useI18n();
  const { status, absPath } = parseDiffPath(diffPath);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    // Deferred a tick so the loading flag is not set synchronously inside the effect.
    const id = setTimeout(async () => {
      setLoading(true);
      setError("");
      const r = await fileBus.gitDiff?.(workspace, absPath, status);
      if (cancelled) return;
      if (r?.success) setDiff(r.diff || "");
      else setError(r?.error || "");
      setLoading(false);
    }, 0);
    return () => { cancelled = true; clearTimeout(id); };
  }, [workspace, absPath, status, fileBus]);

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
