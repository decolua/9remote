"use client";

import { useState, useEffect, useRef } from "react";
import { X, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Edit a snippet's alias + command. Command uses a textarea for long lines.
export default function SnippetEditModal({ snippet, onSave, onClose }) {
  const { t } = useI18n();
  const [alias, setAlias] = useState(snippet?.alias ?? "");
  const [cmd, setCmd] = useState(snippet?.cmd ?? "");
  const cmdRef = useRef(null);

  useEffect(() => {
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  if (!snippet) return null;

  const canSave = cmd.trim().length > 0;
  const handleSave = () => {
    if (!canSave) return;
    vibrate();
    onSave({ cmd: cmd.trim(), alias: alias.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      <div className="relative card-elev max-w-md w-full flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("history.editSnippet")}</h3>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-5 pb-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("history.aliasLabel")}</label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={t("history.aliasPlaceholder")}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-3 py-2 bg-surface-2 text-text font-mono text-sm rounded-brand outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-xs text-text-subtle">{t("history.aliasHint")}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("history.commandLabel")}</label>
            <textarea
              ref={cmdRef}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              rows={3}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-3 py-2 bg-surface-2 text-text font-mono text-sm rounded-brand outline-none focus:ring-1 focus:ring-brand-500 resize-y min-h-[60px] max-h-[240px]"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-surface-3 hover:bg-surface text-text rounded-brand transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-2 text-sm bg-brand-500 hover:bg-brand-500/80 text-white rounded-brand transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={16} />
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
