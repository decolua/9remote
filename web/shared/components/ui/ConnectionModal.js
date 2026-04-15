"use client";

import { useRouter } from "next/navigation";
import Spinner from "./Spinner";
import { vibrate } from "@/shared/utils/vibration";

/**
 * Connection overlay modal - shows when retrying, failed, or waiting for device approval
 * @param {Object} retryStatus - { isRetrying, attempt, maxAttempts, failed }
 * @param {string|null} approvalStatus - null | "pending" | "approved" | "rejected"
 * @param {Function} onLogout - Callback to clear session and redirect
 */
export default function ConnectionModal({ retryStatus, approvalStatus, onLogout }) {
  const router = useRouter();

  const handleBackToLogin = () => {
    if (onLogout) {
      onLogout();
    } else {
      sessionStorage.clear();
      router.push("/login");
    }
  };

  // Device approval: pending
  if (approvalStatus === "pending") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="bg-dark-600 border border-dark-400 rounded-brand-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
          <div className="text-center">
            <Spinner size="lg" />
            <h3 className="text-white text-lg font-semibold mt-4">
              Waiting for Approval
            </h3>
            <p className="text-dark-100 mt-2">
              The agent needs to approve this device before you can connect.
            </p>
            <p className="text-dark-200 text-sm mt-1">
              Check the terminal on your machine.
            </p>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-4 w-full py-2 bg-dark-500 hover:bg-dark-400 text-dark-50 font-medium rounded-brand transition"
            >
              Cancel
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
        <div className="bg-dark-600 border border-dark-400 rounded-brand-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
          <div className="text-center">
            <div className="w-16 h-16 mx-auto bg-red-500/20 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <h3 className="text-white text-lg font-semibold mt-4">
              Device Rejected
            </h3>
            <p className="text-dark-100 mt-2">
              This device was not approved by the agent.
            </p>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-6 w-full py-3 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition"
            >
              Back to Login
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
      <div className="bg-dark-600 border border-dark-400 rounded-brand-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
        {retryStatus.isRetrying ? (
          // Retrying state
          <div className="text-center">
            <Spinner size="lg" />
            <h3 className="text-white text-lg font-semibold mt-4">
              Reconnecting...
            </h3>
            <p className="text-dark-100 mt-2">
              Attempt {retryStatus.attempt} of {retryStatus.maxAttempts}
            </p>
            <div className="mt-4 w-full bg-dark-500 rounded-full h-2">
              <div 
                className="bg-brand-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(retryStatus.attempt / retryStatus.maxAttempts) * 100}%` }}
              />
            </div>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-4 w-full py-2 bg-dark-500 hover:bg-dark-400 text-dark-50 font-medium rounded-brand transition"
            >
              Exit
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
            <h3 className="text-white text-lg font-semibold mt-4">
              Connection Failed
            </h3>
            <p className="text-dark-100 mt-2">
              Unable to connect after {retryStatus.maxAttempts} attempts
            </p>
            <button
              onClick={() => { vibrate(); handleBackToLogin(); }}
              className="mt-6 w-full py-3 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
