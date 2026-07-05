"use client";

import { useEffect } from "react";
import { X, History, Trash2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useHistoryStore } from "@/shared/stores/historyStore";

// Command history picker. Tap a row → fill the input (no auto-send).
export default function CommandHistoryModal({ isOpen, onSelect, onClose }) {
  const { t } = useI18n();
  const history = useHistoryStore((s) => s.history);
  const removeCommand = useHistoryStore((s) => s.removeCommand);
  const clearHistory = useHistoryStore((s) => s.clearHistory);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (cmd) => {
    vibrate();
    onSelect(cmd);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-lg w-full max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("history.title")}</h3>
          <div className="flex items-center gap-1">
            {history.length > 0 && (
              <button
                onClick={() => { vibrate(); clearHistory(); }}
                className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
                aria-label={t("history.clearAll")}
                title={t("history.clearAll")}
              >
                <Trash2 size={18} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
              aria-label={t("common.close")}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto modal-scrollable p-3">
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
              <History size={32} className="opacity-50" />
              <span className="text-sm">{t("history.empty")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {history.map((cmd) => (
                <div
                  key={cmd}
                  className="group flex items-center gap-2 rounded-brand hover:bg-surface-2 transition-all duration-150 ease-out"
                >
                  <button
                    onClick={() => handleSelect(cmd)}
                    className="flex-1 min-w-0 px-3 py-2.5 text-left text-sm text-text font-mono truncate"
                  >
                    {cmd}
                  </button>
                  <button
                    onClick={() => { vibrate(); removeCommand(cmd); }}
                    className="flex-shrink-0 p-2 mr-1 text-text-muted hover:text-text rounded-brand transition-colors"
                    aria-label={t("common.delete")}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
