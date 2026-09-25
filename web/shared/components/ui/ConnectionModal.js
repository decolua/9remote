"use client";

import Spinner from "./Spinner";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { APPROVAL_STATUS, RETRY_MODAL_MIN_ATTEMPT } from "@/shared/constants/transport";

/**
 * Connection overlay modal - shows when retrying, failed, or waiting for device approval
 * @param {Object} retryStatus - { isRetrying, attempt, maxAttempts, failed }
 * @param {string|null} approvalStatus - null, or one of APPROVAL_STATUS
 * @param {boolean} connected - true when any transport (RTC or WS) is alive → suppress retry/failed modal
 * @param {Function} onLogout - Callback to clear session and redirect
 * @param {Function} onRetryNow - Force an immediate reconnect attempt
 * @param {boolean} firstConnect - true until the page has connected once: retry
 *        attempts then are the connect itself, not a lost connection
 */
export default function ConnectionModal({ retryStatus, approvalStatus, connected, onLogout, onRetryNow, suppress = false, firstConnect = false }) {
  const { t } = useI18n();

  // PWA resume grace — tab just became visible; WS/RTC are re-establishing.
  // Suppress the CONNECTION states (retry/failed) so they don't flash, but NOT
  // an approval verdict: that is a standing answer from the host, not a
  // transient carrier state. Hiding it left the user staring at a blank
  // workspace while the agent was still waiting for them to click Approve —
  // and switching to the agent window to click it is exactly what triggers the
  // grace on the way back.
  const isApproval = approvalStatus === APPROVAL_STATUS.pending || approvalStatus === APPROVAL_STATUS.rejected;
  if (suppress && !isApproval) return null;

  const handleBackToLogin = () => {
    if (onLogout) {
      onLogout();
      return;
    }
    // sessionStorage only: clearing localStorage too would drop the saved keys
    // and the remembered login the user still needs on the other side.
    sessionStorage.clear();
    // Full load — a lazy chunk fetch can hang forever on the dead network that got us here
    window.location.replace("/login");
  };

  // Device approval: pending
  if (approvalStatus === APPROVAL_STATUS.pending) {
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
  if (approvalStatus === APPROVAL_STATUS.rejected) {
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

  // Only show when retrying or failed — suppress if a transport is alive (RTC working)
  if (connected || (!retryStatus?.isRetrying && !retryStatus?.failed)) {
    return null;
  }
  // Establishing vs re-establishing: before the page's first connect, a retry
  // attempt is just the connect being slow (the loading screen owns that
  // phase). Only a hard failure needs the buttons here.
  if (firstConnect && !retryStatus?.failed) return null;
  // And an early retry on a live page is a blip, not news: the overlay already
  // carries the "retrying" state, and the buttons only earn their interruption
  // once the attempts are visibly not working.
  if (retryStatus?.isRetrying && retryStatus.attempt < RETRY_MODAL_MIN_ATTEMPT) return null;

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
