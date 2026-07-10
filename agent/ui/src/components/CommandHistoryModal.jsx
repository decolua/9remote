import { useEffect } from "preact/hooks";
import Icon from "./Icon";
import { useI18n } from "../i18n";

// Command history picker. Tap a row → fill input (no auto-send).
export default function CommandHistoryModal({ history = [], onSelect, onRemove, onClear, onClose }) {
  const { t } = useI18n();

  useEffect(() => {
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="glass-card w-full max-w-lg flex flex-col overflow-hidden" style={{ maxHeight: "70vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--text-main)" }}>
            <Icon name="history" size={16} /> {t("history.title")}
          </div>
          <div className="flex items-center gap-1">
            {history.length > 0 && (
              <button onClick={onClear} title={t("history.clearAll")} className="w-7 h-7 flex items-center justify-center rounded-lg card-act">
                <Icon name="trash" size={15} />
              </button>
            )}
            <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg card-act">
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1">
          {history.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>{t("history.empty")}</div>
          ) : (
            history.map((cmd) => (
              <div key={cmd} className="group flex items-center gap-2 px-3 py-2 card-act" style={{ borderBottom: "1px solid var(--border)" }}>
                <button onClick={() => { onSelect(cmd); onClose(); }} className="flex-1 text-left text-sm font-mono truncate" style={{ color: "var(--text-main)" }}>
                  {cmd}
                </button>
                <button onClick={() => onRemove(cmd)} title={t("history.remove")} className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
