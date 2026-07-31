"use client";

import Spinner from "./Spinner";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

/**
 * Connection overlay modal - shows when retrying, failed, or waiting for device approval
 * @param {Object} retryStatus - { isRetrying, attempt, maxAttempts, failed }
 * @param {string|null} approvalStatus - null | "pending" | "approved" | "rejected"
 * @param {Function} onLogout - Callback to clear session and redirect
 * @param {Function} onRetryNow - Force an immediate reconnect attempt
 */
export default function ConnectionModal({ retryStatus, approvalStatus, onLogout, onRetryNow }) {
  const { t } = useI18n();

  const handleBackToLogin = () => {
    if (onLogout) {
      onLogout();
      return;
    }
    sessionStorage.clear();
    // Full load — a lazy chunk fetch can hang forever on the dead network that got us here
    window.location.replace("/login");
  };

  // Device approval: pending
  if (approvalStatus === "pending") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="card-elev p-6 max-w-sm w-full mx-4">
          <div className="text-center">
            <Spinner size="lg" />
            <h3 className="text-text text-lg font-semibold mt-4">
              {t("connection.waitingApproval")}
            </h3>
            <p className="text-text-muted mt-2">
              {t("connection.approvalDescription")}
            </p>
            <p className="text-text-muted text-sm mt-1">
              {t("connection.approvalHint")}
            </p>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-4 w-full py-2 bg-surface-2 hover:bg-surface-3 text-text font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
            >
              {t("connection.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Device approval: rejected
  if (approvalStatus === "rejected") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="card-elev p-6 max-w-sm w-full mx-4">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto bg-red-500/20 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <h3 className="text-text text-lg font-semibold mt-4">
              {t("connection.rejectedTitle")}
            </h3>
            <p className="text-text-muted mt-2">
              {t("connection.rejectedDescription")}
            </p>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-6 w-full py-3 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
            >
              {t("connection.backToLogin")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Only show when retrying or failed
  if (!retryStatus?.isRetrying && !retryStatus?.failed) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="card-elev p-6 max-w-sm w-full mx-4">
        {retryStatus.isRetrying ? (
          // Retrying state
          <div className="text-center">
            <Spinner size="lg" />
            <h3 className="text-text text-lg font-semibold mt-4">
              {t("connection.retrying")}
            </h3>
            <p className="text-text-muted mt-2">
              {t("connection.attemptOf", { n: retryStatus.attempt, total: retryStatus.maxAttempts })}
            </p>
            <div className="mt-4 w-full bg-surface-2 rounded-full h-2">
              <div 
                className="bg-brand-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(retryStatus.attempt / retryStatus.maxAttempts) * 100}%` }}
              />
            </div>
            {onRetryNow && (
              <button
                onClick={() => { vibrate(); onRetryNow(); }}
                className="mt-4 w-full py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
              >
                {t("connection.retry")}
              </button>
            )}
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-2 w-full py-2 bg-surface-2 hover:bg-surface-3 text-text font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
            >
              {t("connection.exit")}
            </button>
          </div>
        ) : (
          // Failed state
          <div className="text-center">
            <div className="w-16 h-16 mx-auto bg-red-500/20 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h3 className="text-text text-lg font-semibold mt-4">
              {t("connection.failed")}
            </h3>
            <p className="text-text-muted mt-2">
              {t("connection.failedDescription", { n: retryStatus.maxAttempts })}
            </p>
            {onRetryNow && (
              <button
                onClick={() => { vibrate(); onRetryNow(); }}
                className="mt-6 w-full py-3 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98]"
              >
                {t("connection.retry")}
              </button>
            )}
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className={`w-full py-3 bg-surface-2 hover:bg-surface-3 text-text font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.98] ${onRetryNow ? "mt-2" : "mt-6"}`}
            >
              {t("connection.backToLogin")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
