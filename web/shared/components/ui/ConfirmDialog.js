"use client";

import { useEffect } from "react";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

export default function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmText, cancelText }) {
  const { t } = useI18n();
  const finalConfirm = confirmText ?? t("common.confirm");
  const finalCancel = cancelText ?? t("common.cancel");
  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={onClose}
      />
      
      {/* Dialog */}
      <div className="relative card-elev max-w-md w-full animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4">
          <h3 className="text-lg font-semibold text-text">{title}</h3>
        </div>
        
        {/* Body */}
        <div className="px-6 pb-4">
          <p className="text-text">{message}</p>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 flex justify-end gap-3">
          <button
            onClick={() => { vibrate(); onClose(); }}
            className="px-4 py-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.98] font-medium"
          >
            {finalCancel}
          </button>
          <button
            onClick={() => {
              vibrate();
              onConfirm();
              onClose();
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-brand transition-all duration-150 ease-out active:scale-[0.98] font-medium"
          >
            {finalConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
