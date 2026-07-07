"use client";

import { useEffect, useState } from "react";
import { X, History, Trash2, Pin, Pencil } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useHistoryStore } from "@/shared/stores/historyStore";
import SnippetEditModal from "./SnippetEditModal";

// Command history picker. Tap a row → fill the input (no auto-send).
export default function CommandHistoryModal({ isOpen, onSelect, onClose }) {
  const { t } = useI18n();
  const history = useHistoryStore((s) => s.history);
  const pinned = useHistoryStore((s) => s.pinned);
  const removeCommand = useHistoryStore((s) => s.removeCommand);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const togglePin = useHistoryStore((s) => s.togglePin);
  const setSnippet = useHistoryStore((s) => s.setSnippet);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    // Hide mobile keyboard by blurring whatever input had focus
    document.activeElement?.blur?.();
    // Skip Esc while the snippet editor is open — it handles its own close.
    const handleEscape = (e) => { if (e.key === "Escape" && !editing) onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, editing]);

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
          {pinned.length === 0 && history.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
              <History size={32} className="opacity-50" />
              <span className="text-sm">{t("history.empty")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-0">
              {pinned.length > 0 && (
                <>
                  <div className="px-3 pt-1 pb-0.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{t("history.snippets")}</div>
                  {pinned.map((snip) => (
                    <div
                      key={`p-${snip.cmd}`}
                      className="group flex items-center gap-2 rounded-brand hover:bg-surface-2 transition-all duration-150 ease-out"
                    >
                      <button
                        onClick={() => handleSelect(snip.cmd)}
                        className="flex-1 min-w-0 px-3 py-1 text-left flex items-center gap-2"
                      >
                        {snip.alias && (
                          <span className="flex-shrink-0 px-1.5 py-0.5 text-xs font-mono font-semibold text-brand-500 bg-brand-500/10 rounded">{snip.alias}</span>
                        )}
                        <span className="min-w-0 text-sm text-text font-mono truncate">{snip.cmd}</span>
                      </button>
                      <button
                        onClick={() => { vibrate(); setEditing(snip); }}
                        className="flex-shrink-0 p-2 text-text-muted hover:text-text rounded-brand transition-colors"
                        aria-label={t("history.editSnippet")}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => { vibrate(); togglePin(snip.cmd); }}
                        className="flex-shrink-0 p-2 mr-1 text-brand-500 hover:text-brand-400 rounded-brand transition-colors"
                        aria-label={t("history.unpin")}
                      >
                        <Pin size={16} fill="currentColor" />
                      </button>
                    </div>
                  ))}
                  <div className="h-px bg-border/40 my-1" />
                </>
              )}
              {history.length > 0 && (
                <>
                  {pinned.length > 0 && (
                    <div className="px-3 pt-0.5 pb-0.5 text-xs font-semibold uppercase tracking-wide text-text-muted">{t("history.history")}</div>
                  )}
                  {history.map((cmd) => {
                    const isPinned = pinned.some((s) => s.cmd === cmd);
                    return (
                      <div
                        key={cmd}
                        className="group flex items-center gap-2 rounded-brand hover:bg-surface-2 transition-all duration-150 ease-out"
                      >
                        <button
                          onClick={() => handleSelect(cmd)}
                          className="flex-1 min-w-0 px-3 py-1 text-left text-sm text-text font-mono truncate"
                        >
                          {cmd}
                        </button>
                        <button
                          onClick={() => { vibrate(); togglePin(cmd); }}
                          className={`flex-shrink-0 p-2 rounded-brand transition-colors ${isPinned ? "text-brand-500 hover:text-brand-400" : "text-text-muted hover:text-text"}`}
                          aria-label={isPinned ? t("history.unpin") : t("history.pin")}
                        >
                          <Pin size={16} fill={isPinned ? "currentColor" : "none"} />
                        </button>
                        <button
                          onClick={() => { vibrate(); removeCommand(cmd); }}
                          className="flex-shrink-0 p-2 mr-1 text-text-muted hover:text-text rounded-brand transition-colors"
                          aria-label={t("common.delete")}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <SnippetEditModal
          snippet={editing}
          onSave={(next) => setSnippet(editing.cmd, next)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
