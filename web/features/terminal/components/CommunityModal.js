"use client";

import { useEffect } from "react";
import Icon, { X, ExternalLink } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { COMMUNITY_LINKS } from "@/features/terminal/constants/communityLinks";
import { useI18n } from "@/shared/i18n";

// Community modal - list external links (Facebook, GitHub, ...) driven by config
export default function CommunityModal({ isOpen, onClose }) {
  const { t } = useI18n();
  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleOpen = (url) => {
    vibrate();
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={onClose}
      />

      <div
        className="relative w-full max-w-md card-elev slide-in-top"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg font-semibold text-text">{t("community.title")}</h2>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-2">
          <p className="text-text-muted text-sm px-1 mb-2">
            {t("community.description")}
          </p>
          {COMMUNITY_LINKS.map((link) => {
            return (
              <button
                key={link.id}
                onClick={() => handleOpen(link.url)}
                className="w-full px-4 py-3 bg-surface-2 hover:bg-surface-3 text-text rounded-brand-lg text-left flex items-center gap-3 transition-all duration-150 ease-out active:scale-[0.99] group"
              >
                <span
                  className="flex items-center justify-center w-10 h-10 rounded-brand flex-shrink-0"
                  style={{ backgroundColor: `${link.color}1a`, color: link.color }}
                >
                  <Icon name={link.icon} size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{link.label}</div>
                  {link.description && (
                    <div className="text-text-muted text-xs truncate">{link.description}</div>
                  )}
                </div>
                <ExternalLink className="text-text-muted group-hover:text-brand-500 flex-shrink-0" size={18} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
