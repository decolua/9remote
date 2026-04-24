"use client";

import { useEffect } from "react";
import * as LucideIcons from "lucide-react";
import { X, ExternalLink } from "@/shared/components/ui/Icon";
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={onClose}
      />

      <div
        className="relative w-full max-w-md bg-dark-600 border border-dark-400 rounded-brand-lg shadow-2xl slide-in-top"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-400">
          <h2 className="text-lg font-semibold text-white">{t("community.title")}</h2>
          <button
            onClick={onClose}
            className="p-2 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-2">
          <p className="text-dark-100 text-sm px-1 mb-2">
            {t("community.description")}
          </p>
          {COMMUNITY_LINKS.map((link) => {
            const IconCmp = LucideIcons[link.icon];
            return (
              <button
                key={link.id}
                onClick={() => handleOpen(link.url)}
                className="w-full px-4 py-3 bg-dark-700 hover:bg-dark-500 text-white rounded-brand-lg border border-dark-400 hover:border-brand-500 text-left flex items-center gap-3 transition-all duration-200 group"
              >
                <span
                  className="flex items-center justify-center w-10 h-10 rounded-brand flex-shrink-0"
                  style={{ backgroundColor: `${link.color}1a`, color: link.color }}
                >
                  {IconCmp ? <IconCmp size={22} strokeWidth={2} /> : null}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{link.label}</div>
                  {link.description && (
                    <div className="text-dark-100 text-xs truncate">{link.description}</div>
                  )}
                </div>
                <ExternalLink className="text-dark-100 group-hover:text-brand-500 flex-shrink-0" size={18} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
