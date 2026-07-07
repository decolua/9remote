"use client";

import { useCallback } from "react";
import { Crown, RefreshCw, Loader2, CheckCircle2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import useMobileIAP from "@/shared/hooks/useMobileIAP";
import { useI18n } from "@/shared/i18n";

// Mobile-only IAP upgrade button. Rendered inside slide-over menu.
// Non-mobile → renders nothing; caller should show web Stripe flow instead.
export default function UpgradeButton() {
  const { t } = useI18n();
  const { isNative, products, entitlement, processing, purchase, restore } = useMobileIAP();

  const onBuy = useCallback((sku) => {
    vibrate();
    purchase(sku).catch(() => { /* error surfaced via entitlement refresh */ });
  }, [purchase]);

  const onRestore = useCallback(() => {
    vibrate();
    restore().catch(() => {});
  }, [restore]);

  if (!isNative) return null;
  const active = entitlement.status === "active";

  return (
    <div className="w-full px-1 py-2 flex flex-col gap-1.5">
      {active ? (
        <div className="px-3 py-2 bg-brand-500/10 rounded-brand-lg flex items-center gap-2.5">
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
        </div>
      ) : (
        products.map((p) => (
          <button
            key={p.id || p.productId}
            onClick={() => onBuy(p.id || p.productId)}
            disabled={processing}
            className="w-full px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99] disabled:opacity-50"
          >
            {processing ? <Loader2 className="animate-spin" size={16} /> : <Crown size={16} />}
            <span className="text-sm font-semibold">{p.title || p.name} · {p.localizedPrice || p.price}</span>
          </button>
        ))
      )}

      <button
        onClick={onRestore}
        disabled={processing}
        className="w-full px-3 py-1 text-xs text-text-muted hover:text-text flex items-center gap-2 disabled:opacity-50"
      >
        <RefreshCw size={12} /> {t("menu.upgradeRestore")}
      </button>
    </div>
  );
}
