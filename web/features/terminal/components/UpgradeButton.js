"use client";

import { useCallback } from "react";
import { Crown, CheckCircle2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import useMobileIAP from "@/shared/hooks/useMobileIAP";
import { useI18n } from "@/shared/i18n";

// Mobile-only entry point to the native paywall. Rendered inside slide-over menu.
// Non-mobile → renders nothing; caller should show web Stripe flow instead.
export default function UpgradeButton() {
  const { t } = useI18n();
  const { isNative, entitlement, isPro, openPaywall } = useMobileIAP();

  const onOpen = useCallback(() => {
    vibrate();
    openPaywall();
  }, [openPaywall]);

  if (!isNative) return null;

  return (
    <div className="w-full px-1 py-2">
      {isPro ? (
        <button
          onClick={onOpen}
          className="w-full px-3 py-2 bg-brand-500/10 rounded-brand-lg flex items-center gap-2.5 text-left transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <CheckCircle2 className="text-brand-500" size={16} />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-brand-500">
              {entitlement.plan === "pro_yearly" ? "Pro Yearly" : "Pro Monthly"}
            </span>
            {entitlement.expiresAt && (
              <span className="text-xs text-text-muted">
                {t("menu.upgradeExpires")}: {new Date(entitlement.expiresAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </button>
      ) : (
        <button
          onClick={onOpen}
          className="w-full px-3 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-brand-lg flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <Crown size={16} />
          <span className="text-sm font-semibold">{t("menu.upgrade")}</span>
        </button>
      )}
    </div>
  );
}
