import { useEffect } from "preact/hooks";
import { useI18n } from "../i18n";
import { vibrate } from "../lib/vibrate";

// Port of web ConfirmDialog (Preact). Backdrop + Escape close.
export default function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmText, cancelText }) {
  const { t } = useI18n();
  const finalConfirm = confirmText ?? t("common.confirm");
  const finalCancel = cancelText ?? t("common.cancel");

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose} />
      <div className="relative card-elev max-w-md w-full">
        <div className="px-6 py-4">
          <h3 className="text-lg font-semibold" style={{ color: "var(--text-main)" }}>{title}</h3>
        </div>
        <div className="px-6 pb-4">
          <p style={{ color: "var(--text-main)" }}>{message}</p>
        </div>
        <div className="px-6 py-4 flex justify-end gap-3">
          <button
            onClick={() => { vibrate(); onClose(); }}
            className="px-4 py-2 rounded-lg font-medium transition-all duration-150 ease-out active:scale-[0.98]"
            style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
          >
            {finalCancel}
          </button>
          <button
            onClick={() => { vibrate(); onConfirm?.(); onClose(); }}
            className="btn-primary px-4 py-2 rounded-lg font-medium transition-all duration-150 ease-out active:scale-[0.98]"
          >
            {finalConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
