"use client";

import { useState, useCallback, useEffect } from "react";
import { Loader2, Square } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";

/**
 * Codespace Panel Component
 */
export default function CodespacePanel({ codespaceInfo, socketRef, onStop }) {
  const { t } = useI18n();
  const [autoStart, setAutoStart] = useState(null); // null = loading, true/false = status
  const [toggling, setToggling] = useState(false);

  // Load auto start status on mount
  useEffect(() => {
    if (!socketRef?.current || !codespaceInfo?.isCodespaces) {
      // Not in codespaces or no socket, show OFF state
      if (codespaceInfo?.isCodespaces && !socketRef?.current) {
        console.log("CodespacePanel: socketRef not available");
      }
      setAutoStart(false);
      return;
    }

    socketRef.current.emit("getAutoStartStatus", (result) => {
      console.log("getAutoStartStatus result:", result);
      if (result.success) {
        setAutoStart(result.enabled);
      } else {
        setAutoStart(false);
      }
    });
  }, [socketRef, codespaceInfo]);

  // Toggle auto start
  const handleToggleAutoStart = useCallback(() => {
    if (!socketRef?.current || toggling) return;

    setToggling(true);
    const newValue = !autoStart;

    socketRef.current.emit("setAutoStart", { enabled: newValue }, (result) => {
      setToggling(false);
      if (result.success) {
        setAutoStart(result.enabled);
      }
    });
  }, [socketRef, autoStart, toggling]);

  if (!codespaceInfo) return null;

  return (
    <div className="p-5">
      {/* Info */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center justify-between">
          <span className="text-text-muted text-sm">{t("codespace.name")}</span>
          <span className="text-text font-medium">{codespaceInfo.codespaceName || t("codespace.unknown")}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-muted text-sm">{t("codespace.status")}</span>
          <span className="text-green-400 font-medium flex items-center gap-1">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            {t("codespace.running")}
          </span>
        </div>
      </div>

      {/* Auto Start Toggle */}
      <div className="pt-4 border-t border-border mb-6">
        <div className="flex items-center justify-between py-3">
          <div>
            <span className="text-text text-sm font-medium">{t("codespace.autoStart")}</span>
            <p className="text-text-muted text-xs mt-0.5">{t("codespace.autoStartHint")}</p>
          </div>
          {autoStart === null ? (
            <Loader2 className="animate-spin text-text-muted" size={20} />
          ) : (
            <button
              onClick={handleToggleAutoStart}
              disabled={toggling}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                autoStart ? "bg-brand-500" : "bg-surface-2"
              } ${toggling ? "opacity-50" : ""}`}
            >
              <span
                className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                  autoStart ? "left-7" : "left-1"
                }`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Stop section */}
      <div className="pt-4 border-t border-border space-y-3">
        <button
          onClick={onStop}
          className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-brand transition flex items-center justify-center gap-2"
        >
          <Square size={16} />
          {t("codespace.stop")}
        </button>
        <p className="text-text text-sm flex items-start gap-2">
          <span className="text-yellow-400">💡</span>
          {t("codespace.stopHint")}
        </p>
        <p className="text-text-muted text-xs flex items-start gap-2">
          <span className="text-orange-400">⚠️</span>
          {t("codespace.restartHint")}
        </p>
      </div>
    </div>
  );
}
